import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { parsePlistXml, serializePlistXml } from "../icost-shortcut/plist-xml.mjs";
import {
  CAPTURE_CANCEL_MESSAGE,
  CAPTURE_DEVICE_MARKER,
  CAPTURE_DEVICE_ENDPOINT,
  CAPTURE_PREVIEW_ENDPOINT,
  CAPTURE_SHORTCUT_NAME,
  convertIcostCaptureShortcut,
  convertedActions,
  inspectConvertedIcostCaptureShortcutXml,
} from "./convert-icost-capture-shortcut.mjs";

const URL_ACTION = "is.workflow.actions.url";
const OPEN_URL_ACTION = "is.workflow.actions.openurl";
const URL_ENCODE_ACTION = "is.workflow.actions.urlencode";
const DICTIONARY_VALUE_ACTION = "is.workflow.actions.getvalueforkey";
const LIST_ACTION = "is.workflow.actions.list";
const CHOOSE_ACTION = "is.workflow.actions.choosefromlist";
const ASK_ACTION = "is.workflow.actions.ask";
const TEXT_ACTION = "is.workflow.actions.gettext";
const CONDITIONAL_ACTION = "is.workflow.actions.conditional";
const SHOW_RESULT_ACTION = "is.workflow.actions.showresult";
const SHORTCUT_UUID_PATTERN = /^[0-9A-F]{8}-(?:[0-9A-F]{4}-){3}[0-9A-F]{12}$/iu;
const ICOST_SCHEME = "iCost://";
const ICOST_BOOK_NAME = "出差报销";
const ICOST_BRIDGE_CHOICE = "同时打开 iCost 添加账单";
const ICOST_BRIDGE_SKIP = "仅提交森特（不打开 iCost）";
const ICOST_DUPLICATE_CANCEL = "取消 iCost 写入";
const ICOST_DUPLICATE_CONTINUE = "我确认尚未在 iCost 保存，继续";
const ICOST_BRIDGE_PROMPT = "森特已收到待复核草稿。iCost 是独立写入，可能立即添加账单且不会回传结果；请选择是否打开。";
const ICOST_DUPLICATE_PROMPT = "⚠️ iCost URL 没有防重复和保存回执。\n森特返回 replayed：￼\n如果这里为 true、或你已在 iCost 保存过这笔，请取消。";
const ICOST_EXPENSE_NOTICE = "已尝试打开 iCost 支出添加页面；iCost 是否保存需在 iCost 内确认。森特仍等待小小确认。";
const ICOST_INCOME_NOTICE = "已尝试打开 iCost 收入添加页面；iCost 是否保存需在 iCost 内确认。森特仍等待小小确认。";
const ICOST_DUPLICATE_CANCEL_NOTICE = "已取消 iCost 写入；森特待确认草稿不受影响。";
const ICOST_SKIP_NOTICE = "已提交森特待确认，未打开 iCost。";
const ICOST_INVALID_RESPONSE_NOTICE = "森特响应缺少有效记账条目，未打开 iCost；请勿重复提交，并检查小小是否收到待确认草稿。";

export const ICOST_URL_BRIDGE_SHORTCUT_NAME = "智能截图记账（V8·全屏OCR·官方iCost桥接版）";
export const ICOST_URL_BRIDGE_BASE_NAME = CAPTURE_SHORTCUT_NAME;
export const ICOST_URL_BRIDGE_BASE_VERSION = "V8";
export const ICOST_URL_BRIDGE_OPTIONS = Object.freeze([ICOST_BRIDGE_SKIP, ICOST_BRIDGE_CHOICE]);
export const ICOST_URL_DUPLICATE_OPTIONS = Object.freeze([
  ICOST_DUPLICATE_CANCEL,
  ICOST_DUPLICATE_CONTINUE,
]);

const EXPECTED_V8_ACTION_IDENTIFIERS = Object.freeze(convertedActions([
  {
    WFWorkflowActionIdentifier: "is.workflow.actions.takescreenshot",
    WFWorkflowActionParameters: { UUID: "bridge-contract-screen" },
  },
  {
    WFWorkflowActionIdentifier: "is.workflow.actions.image.crop",
    WFWorkflowActionParameters: { UUID: "bridge-contract-crop" },
  },
  {
    WFWorkflowActionIdentifier: "is.workflow.actions.extracttextfromimage",
    WFWorkflowActionParameters: { UUID: "bridge-contract-ocr" },
  },
  {
    WFWorkflowActionIdentifier: "com.gostraight.smallAccountBook.ICAISnapshotShortcutV7",
    WFWorkflowActionParameters: {
      UUID: "bridge-contract-icost",
      rawText: {
        Value: {
          attachmentsByRange: {
            "{0, 1}": {
              OutputName: "图像中的文本",
              OutputUUID: "bridge-contract-ocr",
              Type: "ActionOutput",
            },
          },
          string: "\uFFFC",
        },
        WFSerializationType: "WFTextTokenString",
      },
    },
  },
], CAPTURE_PREVIEW_ENDPOINT, CAPTURE_DEVICE_ENDPOINT, CAPTURE_DEVICE_MARKER).map(
  (entry) => entry.WFWorkflowActionIdentifier,
));

const uuid = (suffix) => `91D8A400-4A6B-4B7C-9D2E-${BigInt(suffix).toString(16).padStart(12, "0")}`;
const literalToken = (string) => ({ Value: { string }, WFSerializationType: "WFTextTokenString" });
const attachment = (outputUuid, outputName) => ({
  Value: { OutputUUID: outputUuid, OutputName: outputName, Type: "ActionOutput" },
  WFSerializationType: "WFTextTokenAttachment",
});
const conditionalInput = (outputUuid, outputName) => ({ Type: "Variable", Variable: attachment(outputUuid, outputName) });
const action = (identifier, parameters, id) => ({
  WFWorkflowActionIdentifier: identifier,
  WFWorkflowActionParameters: { UUID: id, ...parameters },
});
const controlAction = (identifier, parameters) => ({
  WFWorkflowActionIdentifier: identifier,
  WFWorkflowActionParameters: parameters,
});

function interpolatedText(parts) {
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
    Value: { string, attachmentsByRange },
    WFSerializationType: "WFTextTokenString",
  };
}

function outputUuid(value) {
  if (value?.WFSerializationType === "WFTextTokenAttachment") return value.Value?.OutputUUID ?? null;
  if (value?.WFSerializationType !== "WFTextTokenString") return null;
  const entries = Object.values(value.Value?.attachmentsByRange ?? {});
  return entries.length === 1 ? entries[0]?.OutputUUID ?? null : null;
}

function outputUuids(value) {
  if (value?.WFSerializationType !== "WFTextTokenString") return [];
  return Object.values(value.Value?.attachmentsByRange ?? {})
    .map((entry) => entry?.OutputUUID)
    .filter(Boolean);
}

function literalText(value) {
  return value?.WFSerializationType === "WFTextTokenString"
    ? value.Value?.string ?? null
    : null;
}

function hasExactAttachments(value, expectedAttachments) {
  if (value?.WFSerializationType !== "WFTextTokenString") return false;
  const string = value.Value?.string;
  const actual = value.Value?.attachmentsByRange ?? {};
  if (typeof string !== "string" || Object.keys(actual).length !== expectedAttachments.length) return false;
  const placeholderOffsets = [];
  for (let index = 0; index < string.length; index += 1) {
    if (string[index] === "\uFFFC") placeholderOffsets.push(index);
  }
  if (placeholderOffsets.length !== expectedAttachments.length) return false;
  return expectedAttachments.every(({ outputUuid: expectedUuid, outputName }, index) => {
    const attachmentValue = actual[`{${placeholderOffsets[index]}, 1}`];
    return attachmentValue?.OutputUUID === expectedUuid
      && attachmentValue?.OutputName === outputName
      && attachmentValue?.Type === "ActionOutput"
      && Object.keys(attachmentValue).length === 3;
  });
}

function hasExactAttachment(value, expectedUuid, expectedName) {
  const attachmentValue = value?.Value;
  return value?.WFSerializationType === "WFTextTokenAttachment"
    && attachmentValue?.OutputUUID === expectedUuid
    && attachmentValue?.OutputName === expectedName
    && attachmentValue?.Type === "ActionOutput"
    && Object.keys(attachmentValue).length === 3;
}

function hasExactConditionalInput(value, expectedUuid, expectedName) {
  return value?.Type === "Variable"
    && Object.keys(value).length === 2
    && hasExactAttachment(value.Variable, expectedUuid, expectedName);
}

function hasExactPropertyAttachment(value, expectedUuid, expectedName, expectedProperty) {
  const attachmentValue = value?.Value;
  const aggrandizements = attachmentValue?.Aggrandizements;
  return value?.WFSerializationType === "WFTextTokenAttachment"
    && attachmentValue?.OutputUUID === expectedUuid
    && attachmentValue?.OutputName === expectedName
    && attachmentValue?.Type === "ActionOutput"
    && Object.keys(attachmentValue).sort().join("|") === "Aggrandizements|OutputName|OutputUUID|Type"
    && Array.isArray(aggrandizements)
    && aggrandizements.length === 1
    && aggrandizements[0]?.PropertyName === expectedProperty
    && aggrandizements[0]?.Type === "WFPropertyVariableAggrandizement"
    && Object.keys(aggrandizements[0]).sort().join("|") === "PropertyName|Type";
}

function assertTrustedCapturePrefix(actions) {
  const [screenshot, crop, croppedOcr] = actions;
  const screenshotParameters = params(screenshot);
  const cropParameters = params(crop);
  const croppedOcrParameters = params(croppedOcr);
  if (identifier(screenshot) !== "is.workflow.actions.takescreenshot"
    || !SHORTCUT_UUID_PATTERN.test(screenshotParameters.UUID ?? "")
    || Object.keys(screenshot).sort().join("|") !== "WFWorkflowActionIdentifier|WFWorkflowActionParameters"
    || Object.keys(screenshotParameters).join("|") !== "UUID") {
    throw new Error("截屏动作参数不符合受信源快捷指令合同");
  }
  const expectedCropKeys = [
    "UUID",
    "WFImageCropHeight",
    "WFImageCropPosition",
    "WFImageCropWidth",
    "WFImageCropY",
    "WFInput",
  ];
  if (identifier(crop) !== "is.workflow.actions.image.crop"
    || !SHORTCUT_UUID_PATTERN.test(cropParameters.UUID ?? "")
    || Object.keys(crop).sort().join("|") !== "WFWorkflowActionIdentifier|WFWorkflowActionParameters"
    || JSON.stringify(Object.keys(cropParameters).sort()) !== JSON.stringify(expectedCropKeys)
    || cropParameters.WFImageCropPosition !== "Custom"
    || cropParameters.WFImageCropY !== "120"
    || !hasExactAttachment(cropParameters.WFInput, screenshotParameters.UUID, "截屏")
    || !hasExactPropertyAttachment(
      cropParameters.WFImageCropWidth,
      screenshotParameters.UUID,
      "截屏",
      "Width",
    )
    || !hasExactPropertyAttachment(
      cropParameters.WFImageCropHeight,
      screenshotParameters.UUID,
      "截屏",
      "Height",
    )) {
    throw new Error("裁剪动作参数不符合受信源快捷指令合同");
  }
  if (identifier(croppedOcr) !== "is.workflow.actions.extracttextfromimage"
    || !SHORTCUT_UUID_PATTERN.test(croppedOcrParameters.UUID ?? "")
    || Object.keys(croppedOcr).sort().join("|") !== "WFWorkflowActionIdentifier|WFWorkflowActionParameters"
    || JSON.stringify(Object.keys(croppedOcrParameters).sort()) !== JSON.stringify(["UUID", "WFImage"])
    || !hasExactAttachment(croppedOcrParameters.WFImage, cropParameters.UUID, "裁剪后的图像")) {
    throw new Error("裁剪 OCR 动作参数不符合受信源快捷指令合同");
  }
}

function canonicalV8Actions(baseActions, deviceToken) {
  const sourcePrefix = baseActions.slice(0, 3).map((entry) => structuredClone(entry));
  const croppedOcrUuid = params(sourcePrefix[2]).UUID;
  return convertedActions([
    ...sourcePrefix,
    {
      WFWorkflowActionIdentifier: "com.gostraight.smallAccountBook.ICAISnapshotShortcutV7",
      WFWorkflowActionParameters: {
        UUID: "bridge-canonical-source-icost",
        rawText: interpolatedText([{
          outputUuid: croppedOcrUuid,
          outputName: "图像中的文本",
        }]),
      },
    },
  ], CAPTURE_PREVIEW_ENDPOINT, CAPTURE_DEVICE_ENDPOINT, deviceToken);
}

function params(entry) {
  return entry?.WFWorkflowActionParameters ?? {};
}

function identifier(entry) {
  return entry?.WFWorkflowActionIdentifier;
}

function findNamed(actions, name) {
  const matches = actions
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => params(entry).CustomOutputName === name);
  if (matches.length !== 1) throw new Error(`动作“${name}”缺失或重复`);
  return matches[0];
}

function conditionalRanges(actions) {
  const stack = [];
  const ranges = new Map();
  actions.forEach((entry, index) => {
    if (identifier(entry) !== CONDITIONAL_ACTION) return;
    const parameters = params(entry);
    const group = parameters.GroupingIdentifier;
    const mode = parameters.WFControlFlowMode;
    if (typeof group !== "string" || !group) throw new Error("条件动作缺少分组标识");
    if (mode === 0) {
      if (ranges.has(group) || stack.some((item) => item.group === group)) throw new Error("条件分组标识重复");
      stack.push({ group, start: index, otherwise: null });
      return;
    }
    const current = stack.at(-1);
    if (!current || current.group !== group) throw new Error("条件动作嵌套或分组标识不匹配");
    if (mode === 1) {
      if (current.otherwise !== null) throw new Error("条件分组包含重复的否则分支");
      current.otherwise = index;
      return;
    }
    if (mode !== 2) throw new Error("条件动作控制模式无效");
    stack.pop();
    ranges.set(group, { ...current, end: index });
  });
  if (stack.length) throw new Error("条件动作缺少结束动作");
  return ranges;
}

function findGuardRange(actions, ranges, inputUuid) {
  const starts = actions
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => (
      identifier(entry) === CONDITIONAL_ACTION
      && params(entry).WFControlFlowMode === 0
      && outputUuid(params(entry).WFInput?.Variable) === inputUuid
    ));
  if (starts.length !== 1) throw new Error("目标条件守卫缺失或重复");
  const range = ranges.get(params(starts[0].entry).GroupingIdentifier);
  if (!range) throw new Error("目标条件守卫范围缺失");
  return range;
}

function existingUuidSet(actions) {
  return new Set(actions.flatMap((entry) => [
    params(entry).UUID,
    params(entry).GroupingIdentifier,
  ]).filter(Boolean));
}

function makeIdAllocator(actions) {
  const used = existingUuidSet(actions);
  let suffix = 0x3000;
  return () => {
    let candidate;
    do {
      candidate = uuid(suffix++);
    } while (used.has(candidate));
    used.add(candidate);
    return candidate;
  };
}

function bridgeActions(actions) {
  const finalRequest = findNamed(actions, "已提交小小待确认");
  const finalError = findNamed(actions, "最终提交错误");
  const finalConfirm = findNamed(actions, "本机最终确认");
  const amount = findNamed(actions, "金额");
  const entry = findNamed(actions, "已选收支");
  const category = findNamed(actions, "最终类别");
  const subcategory = findNamed(actions, "最终子类");
  const note = findNamed(actions, "备注（可选）");

  if (identifier(finalRequest.entry) !== "is.workflow.actions.downloadurl") {
    throw new Error("基础快捷指令的森特提交动作类型不正确");
  }
  if (identifier(finalConfirm.entry) !== CHOOSE_ACTION) throw new Error("基础快捷指令缺少本机最终确认");
  if (!outputUuid(params(finalRequest.entry).WFJSONValues?.Value?.WFDictionaryFieldValueItems
    ?.find((item) => item.WFKey?.Value?.string === "text")?.WFValue)) {
    throw new Error("基础快捷指令的最终提交文本无效");
  }

  const ranges = conditionalRanges(actions);
  const finalConfirmRange = findGuardRange(actions, ranges, finalConfirm.entry.WFWorkflowActionParameters.UUID);
  const finalErrorRange = findGuardRange(actions, ranges, finalError.entry.WFWorkflowActionParameters.UUID);
  if (finalConfirmRange.otherwise === null) throw new Error("最终确认守卫缺少取消分支");
  if (finalErrorRange.otherwise !== null) throw new Error("基础最终提交错误守卫不应已有否则分支");
  if (!(finalRequest.index > finalConfirmRange.start && finalRequest.index < finalConfirmRange.otherwise)) {
    throw new Error("森特提交不在本机最终确认的确定分支");
  }

  const nextId = makeIdAllocator(actions);
  const responseItem = nextId();
  const responseItemId = nextId();
  const successGuard = nextId();
  const responseItemStatus = nextId();
  const statusGuard = nextId();
  const choiceList = nextId();
  const choice = nextId();
  const bridgeGuard = nextId();
  const replayed = nextId();
  const duplicateList = nextId();
  const duplicateChoice = nextId();
  const duplicateGuard = nextId();
  const book = nextId();
  const remark = nextId();
  const encodedAmount = nextId();
  const encodedCategory = nextId();
  const encodedBook = nextId();
  const encodedRemark = nextId();
  const entryTypeGuard = nextId();
  const expenseUrl = nextId();
  const expenseOpen = nextId();
  const incomeUrl = nextId();
  const incomeOpen = nextId();

  const encode = (inputUuid, inputName, outputName, id) => action(URL_ENCODE_ACTION, {
    CustomOutputName: outputName,
    WFInput: attachment(inputUuid, inputName),
    WFEncodeMode: "Encode",
  }, id);

  const url = (path, id, outputName) => action(URL_ACTION, {
    CustomOutputName: outputName,
    WFURLActionURL: interpolatedText([
      `${ICOST_SCHEME}${path}?amount=`,
      { outputUuid: encodedAmount, outputName: "iCost金额（已编码）" },
      "&category=",
      { outputUuid: encodedCategory, outputName: "iCost分类（已编码）" },
      "&book=",
      { outputUuid: encodedBook, outputName: "iCost账本（已编码）" },
      "&remark=",
      { outputUuid: encodedRemark, outputName: "iCost备注（已编码）" },
    ]),
  }, id);

  const bridge = [
    action(DICTIONARY_VALUE_ACTION, {
      CustomOutputName: "森特提交条目",
      WFDictionaryKey: "item",
      WFInput: attachment(finalRequest.entry.WFWorkflowActionParameters.UUID, "已提交小小待确认"),
    }, responseItem),
    action(DICTIONARY_VALUE_ACTION, {
      CustomOutputName: "森特提交条目ID",
      WFDictionaryKey: "id",
      WFInput: attachment(responseItem, "森特提交条目"),
    }, responseItemId),
    controlAction(CONDITIONAL_ACTION, {
      GroupingIdentifier: successGuard,
      WFCondition: 100,
      WFControlFlowMode: 0,
      WFInput: conditionalInput(responseItemId, "森特提交条目ID"),
    }),
    action(DICTIONARY_VALUE_ACTION, {
      CustomOutputName: "森特提交条目状态",
      WFDictionaryKey: "status",
      WFInput: attachment(responseItem, "森特提交条目"),
    }, responseItemStatus),
    controlAction(CONDITIONAL_ACTION, {
      GroupingIdentifier: statusGuard,
      WFCondition: 4,
      WFConditionalActionString: "review_required",
      WFControlFlowMode: 0,
      WFInput: conditionalInput(responseItemStatus, "森特提交条目状态"),
    }),
    action(LIST_ACTION, {
      CustomOutputName: "iCost同步选项",
      WFItems: [...ICOST_URL_BRIDGE_OPTIONS],
    }, choiceList),
    action(CHOOSE_ACTION, {
      CustomOutputName: "iCost同步决定",
      WFChooseFromListActionPrompt: ICOST_BRIDGE_PROMPT,
      WFInput: attachment(choiceList, "iCost同步选项"),
    }, choice),
    controlAction(CONDITIONAL_ACTION, {
      GroupingIdentifier: bridgeGuard,
      WFCondition: 4,
      WFConditionalActionString: ICOST_BRIDGE_CHOICE,
      WFControlFlowMode: 0,
      WFInput: conditionalInput(choice, "iCost同步决定"),
    }),
    action(DICTIONARY_VALUE_ACTION, {
      CustomOutputName: "森特是否重放",
      WFDictionaryKey: "replayed",
      WFInput: attachment(responseItem, "森特提交条目"),
    }, replayed),
    action(LIST_ACTION, {
      CustomOutputName: "iCost防重复选项",
      WFItems: [...ICOST_URL_DUPLICATE_OPTIONS],
    }, duplicateList),
    action(CHOOSE_ACTION, {
      CustomOutputName: "iCost防重复确认",
      WFChooseFromListActionPrompt: interpolatedText([
        "⚠️ iCost URL 没有防重复和保存回执。\n森特返回 replayed：",
        { outputUuid: replayed, outputName: "森特是否重放" },
        "\n如果这里为 true、或你已在 iCost 保存过这笔，请取消。",
      ]),
      WFInput: attachment(duplicateList, "iCost防重复选项"),
    }, duplicateChoice),
    controlAction(CONDITIONAL_ACTION, {
      GroupingIdentifier: duplicateGuard,
      WFCondition: 4,
      WFConditionalActionString: ICOST_DUPLICATE_CONTINUE,
      WFControlFlowMode: 0,
      WFInput: conditionalInput(duplicateChoice, "iCost防重复确认"),
    }),
    action(TEXT_ACTION, {
      CustomOutputName: "iCost账本",
      WFTextActionText: literalToken(ICOST_BOOK_NAME),
    }, book),
    action(TEXT_ACTION, {
      CustomOutputName: "iCost备注原文",
      WFTextActionText: interpolatedText([
        "子类：",
        { outputUuid: subcategory.entry.WFWorkflowActionParameters.UUID, outputName: "最终子类" },
        "\n备注：",
        { outputUuid: note.entry.WFWorkflowActionParameters.UUID, outputName: "备注（可选）" },
      ]),
    }, remark),
    encode(amount.entry.WFWorkflowActionParameters.UUID, "金额", "iCost金额（已编码）", encodedAmount),
    encode(category.entry.WFWorkflowActionParameters.UUID, "最终类别", "iCost分类（已编码）", encodedCategory),
    encode(book, "iCost账本", "iCost账本（已编码）", encodedBook),
    encode(remark, "iCost备注原文", "iCost备注（已编码）", encodedRemark),
    controlAction(CONDITIONAL_ACTION, {
      GroupingIdentifier: entryTypeGuard,
      WFCondition: 4,
      WFConditionalActionString: "支出",
      WFControlFlowMode: 0,
      WFInput: conditionalInput(entry.entry.WFWorkflowActionParameters.UUID, "已选收支"),
    }),
    url("expense", expenseUrl, "iCost支出URL"),
    action(OPEN_URL_ACTION, {
      WFInput: attachment(expenseUrl, "iCost支出URL"),
    }, expenseOpen),
    controlAction(SHOW_RESULT_ACTION, {
      Text: literalToken(ICOST_EXPENSE_NOTICE),
    }),
    controlAction(CONDITIONAL_ACTION, {
      GroupingIdentifier: entryTypeGuard,
      WFControlFlowMode: 1,
    }),
    url("income", incomeUrl, "iCost收入URL"),
    action(OPEN_URL_ACTION, {
      WFInput: attachment(incomeUrl, "iCost收入URL"),
    }, incomeOpen),
    controlAction(SHOW_RESULT_ACTION, {
      Text: literalToken(ICOST_INCOME_NOTICE),
    }),
    controlAction(CONDITIONAL_ACTION, {
      GroupingIdentifier: entryTypeGuard,
      WFControlFlowMode: 2,
    }),
    controlAction(CONDITIONAL_ACTION, {
      GroupingIdentifier: duplicateGuard,
      WFControlFlowMode: 1,
    }),
    controlAction(SHOW_RESULT_ACTION, {
      Text: literalToken(ICOST_DUPLICATE_CANCEL_NOTICE),
    }),
    controlAction(CONDITIONAL_ACTION, {
      GroupingIdentifier: duplicateGuard,
      WFControlFlowMode: 2,
    }),
    controlAction(CONDITIONAL_ACTION, {
      GroupingIdentifier: bridgeGuard,
      WFControlFlowMode: 1,
    }),
    controlAction(SHOW_RESULT_ACTION, {
      Text: literalToken(ICOST_SKIP_NOTICE),
    }),
    controlAction(CONDITIONAL_ACTION, {
      GroupingIdentifier: bridgeGuard,
      WFControlFlowMode: 2,
    }),
    controlAction(CONDITIONAL_ACTION, {
      GroupingIdentifier: statusGuard,
      WFControlFlowMode: 1,
    }),
    controlAction(SHOW_RESULT_ACTION, {
      Text: literalToken(ICOST_INVALID_RESPONSE_NOTICE),
    }),
    controlAction(CONDITIONAL_ACTION, {
      GroupingIdentifier: statusGuard,
      WFControlFlowMode: 2,
    }),
    controlAction(CONDITIONAL_ACTION, {
      GroupingIdentifier: successGuard,
      WFControlFlowMode: 1,
    }),
    controlAction(SHOW_RESULT_ACTION, {
      Text: literalToken(ICOST_INVALID_RESPONSE_NOTICE),
    }),
    controlAction(CONDITIONAL_ACTION, {
      GroupingIdentifier: successGuard,
      WFControlFlowMode: 2,
    }),
  ];

  // The existing V8 flow reports a failed capture in the final-error branch.
  // Put the iCost choice in that guard's otherwise branch so an HTTP failure
  // cannot still trigger an external iCost write.
  const insertionIndex = finalErrorRange.end;
  const otherwise = controlAction(CONDITIONAL_ACTION, {
    GroupingIdentifier: params(actions[finalErrorRange.start]).GroupingIdentifier,
    WFControlFlowMode: 1,
  });
  const end = structuredClone(actions[insertionIndex]);
  const updated = [...actions];
  updated.splice(insertionIndex, 1, otherwise, ...bridge, end);

  const updatedRanges = conditionalRanges(updated);
  const updatedFinalErrorRange = updatedRanges.get(params(actions[finalErrorRange.start]).GroupingIdentifier);
  if (!updatedFinalErrorRange || updatedFinalErrorRange.otherwise === null) {
    throw new Error("iCost 桥接未插入最终提交成功分支");
  }
  const bridgeStart = updatedFinalErrorRange.otherwise + 1;
  const bridgeEnd = updatedFinalErrorRange.end;
  if (bridgeEnd - bridgeStart !== bridge.length) throw new Error("iCost 桥接动作范围异常");

  return {
    actions: updated,
    report: {
      actionCount: updated.length,
      baseActionCount: actions.length,
      baseShortcutName: ICOST_URL_BRIDGE_BASE_NAME,
      baseVersion: ICOST_URL_BRIDGE_BASE_VERSION,
      preservesFullOcrBase: true,
      preservesLocalFinalConfirmation: true,
      captureBeforeIcostChoice: true,
      iCostOpenAttempted: true,
      iCostReadback: false,
      iCostAtomicWithCapture: false,
      iCostUrlScheme: ICOST_SCHEME,
      iCostQueryKeys: ["amount", "category", "book", "remark"],
      iCostQueryValuesEncoded: true,
      iCostRawOcrNotSent: true,
      iCostCredentialsPresent: false,
      iCostExpenseAndIncomeBranches: true,
      iCostBookName: ICOST_BOOK_NAME,
      iCostReplayWarning: true,
      iCostSecondConfirmation: true,
      iCostRequiresResponseItemId: true,
      iCostRequiresReviewRequiredStatus: true,
      bridgeActionCount: bridge.length,
      bridgeRange: { start: bridgeStart, end: bridgeEnd },
    },
  };
}

function assertBaseIsV8(plist) {
  const actions = plist?.WFWorkflowActions;
  if (!Array.isArray(actions) || actions.length < 90) throw new Error("输入必须是已验证的 V8 全屏 OCR unsigned 快捷指令");
  if (actions.some((entry) => identifier(entry) === "com.gostraight.smallAccountBook.ICAISnapshotShortcutV7")) {
    throw new Error("bridge 不保留 iCost 私有 App Intent；请先生成 V8 全屏 OCR 基础制品");
  }
  for (const name of ["全屏OCR", "OCR纯文本", "金额预览响应", "已提交小小待确认", "本机最终确认"]) findNamed(actions, name);
}

function applyDeviceTokenToV8(plist, deviceToken) {
  if (deviceToken === CAPTURE_DEVICE_MARKER) return plist;

  // A V8 unsigned artifact normally carries the explicit marker.  Replace
  // only the three canonical HTTP Authorization values; refusing to guess at
  // an already-bound token prevents silently sending one shortcut to another
  // account.  The token itself is never included in the returned report.
  const xml = serializePlistXml(plist);
  const marker = `Bearer ${CAPTURE_DEVICE_MARKER}`;
  const occurrences = xml.split(marker).length - 1;
  if (occurrences !== 3) {
    throw new Error("V8 unsigned 制品必须包含恰好 3 个设备凭据占位符；拒绝覆盖已有绑定");
  }
  const boundXml = xml.replaceAll(marker, `Bearer ${deviceToken}`);
  const bound = parsePlistXml(boundXml);
  assertBaseIsV8(bound);
  return bound;
}

export function inspectIcostUrlBridgeShortcutXml(xml) {
  const plist = parsePlistXml(xml);
  if (Object.hasOwn(plist, "WFWorkflowImportQuestions")
    && (!Array.isArray(plist.WFWorkflowImportQuestions)
      || plist.WFWorkflowImportQuestions.length !== 0)) {
    throw new Error("iCost bridge 不允许导入问题改写已验证参数");
  }
  assertBaseIsV8(plist);
  const actual = plist.WFWorkflowActions;
  assertTrustedCapturePrefix(actual);
  const actionUuids = actual.map((entry) => params(entry).UUID).filter(Boolean);
  const groupingIdentifiers = actual
    .map((entry) => params(entry).GroupingIdentifier)
    .filter(Boolean);
  if (actual.some((entry) => Object.keys(entry).sort().join("|") !== "WFWorkflowActionIdentifier|WFWorkflowActionParameters")) {
    throw new Error("iCost bridge 动作顶层结构不正确");
  }
  if (actionUuids.some((value) => !SHORTCUT_UUID_PATTERN.test(value))) {
    throw new Error("iCost bridge 动作 UUID 格式不正确");
  }
  if (groupingIdentifiers.some((value) => !SHORTCUT_UUID_PATTERN.test(value))) {
    throw new Error("iCost bridge 条件分组 UUID 格式不正确");
  }
  if (new Set(actionUuids).size !== actionUuids.length) throw new Error("iCost bridge 动作 UUID 不得重复");
  if (groupingIdentifiers.some((group) => actionUuids.includes(group))) {
    throw new Error("iCost bridge 条件分组标识不得与动作 UUID 冲突");
  }
  const bridgeStartIndex = actual.findIndex(
    (entry) => params(entry).CustomOutputName === "森特提交条目",
  );
  const bridgeChoiceIndex = actual.findIndex(
    (entry) => params(entry).CustomOutputName === "iCost同步选项",
  );
  if (bridgeStartIndex < 1 || bridgeChoiceIndex <= bridgeStartIndex) {
    throw new Error("iCost bridge 响应守卫或选择动作缺失");
  }
  const finalRequest = findNamed(actual, "已提交小小待确认");
  const finalError = findNamed(actual, "最终提交错误");
  if (identifier(finalError.entry) !== DICTIONARY_VALUE_ACTION
    || params(finalError.entry).WFDictionaryKey !== "error"
    || !hasExactAttachment(
      params(finalError.entry).WFInput,
      params(finalRequest.entry).UUID,
      "已提交小小待确认",
    )) {
    throw new Error("最终提交错误必须读取森特提交响应的 error 字段");
  }
  const ranges = conditionalRanges(actual);
  const finalErrorRange = findGuardRange(actual, ranges, params(finalError.entry).UUID);
  const finalErrorGuardStart = actual[finalErrorRange.start];
  const finalErrorGroup = params(finalErrorGuardStart).GroupingIdentifier;
  if (params(finalErrorGuardStart).WFCondition !== 100
    || !hasExactConditionalInput(
      params(finalErrorGuardStart).WFInput,
      params(finalError.entry).UUID,
      "最终提交错误",
    )) {
    throw new Error("最终提交错误守卫必须仅在 error 有值时进入失败分支");
  }
  const finalErrorEndIndex = finalErrorRange.end;
  const otherwiseMarker = actual[bridgeStartIndex - 1];
  if (!(identifier(otherwiseMarker) === CONDITIONAL_ACTION
    && params(otherwiseMarker).GroupingIdentifier === finalErrorGroup
    && params(otherwiseMarker).WFControlFlowMode === 1
    && finalErrorRange.otherwise === bridgeStartIndex - 1)) {
    throw new Error("iCost bridge 未位于最终提交错误守卫的成功分支");
  }
  // Re-run the existing V8 verifier against a bridge-stripped view.  The V8
  // contract intentionally requires exactly eight Choose actions; the bridge
  // adds local choices, so validating the full plist against that
  // older exact-count contract would reject a valid bridge.
  const baseActions = [
    ...actual.slice(0, bridgeStartIndex - 1),
    ...actual.slice(finalErrorEndIndex),
  ];
  if (JSON.stringify(baseActions.map(identifier)) !== JSON.stringify(EXPECTED_V8_ACTION_IDENTIFIERS)) {
    throw new Error("V8 基础动作序列不正确或包含额外动作");
  }
  if (baseActions.length !== 101) throw new Error("V8 基础动作数量不正确");
  const baseReport = inspectConvertedIcostCaptureShortcutXml(
    serializePlistXml({ ...plist, WFWorkflowActions: baseActions }),
  );

  const bridge = actual.slice(bridgeStartIndex, finalErrorEndIndex);
  const expectedBridgeIdentifiers = [
    DICTIONARY_VALUE_ACTION,
    DICTIONARY_VALUE_ACTION,
    CONDITIONAL_ACTION,
    DICTIONARY_VALUE_ACTION,
    CONDITIONAL_ACTION,
    LIST_ACTION,
    CHOOSE_ACTION,
    CONDITIONAL_ACTION,
    DICTIONARY_VALUE_ACTION,
    LIST_ACTION,
    CHOOSE_ACTION,
    CONDITIONAL_ACTION,
    TEXT_ACTION,
    TEXT_ACTION,
    URL_ENCODE_ACTION,
    URL_ENCODE_ACTION,
    URL_ENCODE_ACTION,
    URL_ENCODE_ACTION,
    CONDITIONAL_ACTION,
    URL_ACTION,
    OPEN_URL_ACTION,
    SHOW_RESULT_ACTION,
    CONDITIONAL_ACTION,
    URL_ACTION,
    OPEN_URL_ACTION,
    SHOW_RESULT_ACTION,
    CONDITIONAL_ACTION,
    CONDITIONAL_ACTION,
    SHOW_RESULT_ACTION,
    CONDITIONAL_ACTION,
    CONDITIONAL_ACTION,
    SHOW_RESULT_ACTION,
    CONDITIONAL_ACTION,
    CONDITIONAL_ACTION,
    SHOW_RESULT_ACTION,
    CONDITIONAL_ACTION,
    CONDITIONAL_ACTION,
    SHOW_RESULT_ACTION,
    CONDITIONAL_ACTION,
  ];
  if (JSON.stringify(bridge.map(identifier)) !== JSON.stringify(expectedBridgeIdentifiers)) {
    throw new Error("iCost bridge 动作顺序不正确");
  }
  if (bridge.length !== 39 || actual.length !== 141) throw new Error("iCost bridge 动作数量不正确");
  const [
    responseItem,
    responseItemId,
    successGuardStart,
    responseItemStatus,
    statusGuardStart,
    syncOptions,
    syncChoice,
    syncGuardStart,
    replayed,
    duplicateOptions,
    duplicateChoice,
    duplicateGuardStart,
    book,
    remark,
    amountEncode,
    categoryEncode,
    bookEncode,
    remarkEncode,
    entryGuardStart,
    expenseUrl,
    expenseOpen,
    expenseNotice,
    entryGuardOtherwise,
    incomeUrl,
    incomeOpen,
    incomeNotice,
    entryGuardEnd,
    duplicateGuardOtherwise,
    duplicateCancelNotice,
    duplicateGuardEnd,
    syncGuardOtherwise,
    skipNotice,
    syncGuardEnd,
    statusGuardOtherwise,
    statusInvalidNotice,
    statusGuardEnd,
    successGuardOtherwise,
    successInvalidNotice,
    successGuardEnd,
  ] = bridge;
  const expectedNamedActions = new Map([
    [responseItem, "森特提交条目"],
    [responseItemId, "森特提交条目ID"],
    [responseItemStatus, "森特提交条目状态"],
    [syncOptions, "iCost同步选项"],
    [syncChoice, "iCost同步决定"],
    [replayed, "森特是否重放"],
    [duplicateOptions, "iCost防重复选项"],
    [duplicateChoice, "iCost防重复确认"],
    [book, "iCost账本"],
    [remark, "iCost备注原文"],
    [amountEncode, "iCost金额（已编码）"],
    [categoryEncode, "iCost分类（已编码）"],
    [bookEncode, "iCost账本（已编码）"],
    [remarkEncode, "iCost备注（已编码）"],
    [expenseUrl, "iCost支出URL"],
    [incomeUrl, "iCost收入URL"],
  ]);
  for (const [entry, expectedName] of expectedNamedActions) {
    if (params(entry).CustomOutputName !== expectedName) throw new Error(`iCost bridge 缺少 ${expectedName}`);
  }
  if (params(responseItem).WFDictionaryKey !== "item"
    || !hasExactAttachment(params(responseItem).WFInput, params(finalRequest.entry).UUID, "已提交小小待确认")
    || params(responseItemId).WFDictionaryKey !== "id"
    || !hasExactAttachment(params(responseItemId).WFInput, params(responseItem).UUID, "森特提交条目")
    || params(responseItemStatus).WFDictionaryKey !== "status"
    || !hasExactAttachment(params(responseItemStatus).WFInput, params(responseItem).UUID, "森特提交条目")) {
    throw new Error("iCost bridge 必须读取森特成功响应的 item.id 和 item.status");
  }
  const successGuard = params(successGuardStart).GroupingIdentifier;
  if (!successGuard
    || params(successGuardStart).WFControlFlowMode !== 0
    || params(successGuardStart).WFCondition !== 100
    || !hasExactConditionalInput(params(successGuardStart).WFInput, params(responseItemId).UUID, "森特提交条目ID")
    || params(successGuardOtherwise).GroupingIdentifier !== successGuard
    || params(successGuardOtherwise).WFControlFlowMode !== 1
    || params(successGuardEnd).GroupingIdentifier !== successGuard
    || params(successGuardEnd).WFControlFlowMode !== 2
    || literalText(params(successInvalidNotice).Text) !== ICOST_INVALID_RESPONSE_NOTICE) {
    throw new Error("iCost bridge 必须在森特响应 item.id 有值后才允许继续");
  }
  const statusGuard = params(statusGuardStart).GroupingIdentifier;
  if (!statusGuard
    || params(statusGuardStart).WFControlFlowMode !== 0
    || params(statusGuardStart).WFCondition !== 4
    || params(statusGuardStart).WFConditionalActionString !== "review_required"
    || !hasExactConditionalInput(
      params(statusGuardStart).WFInput,
      params(responseItemStatus).UUID,
      "森特提交条目状态",
    )
    || params(statusGuardOtherwise).GroupingIdentifier !== statusGuard
    || params(statusGuardOtherwise).WFControlFlowMode !== 1
    || params(statusGuardEnd).GroupingIdentifier !== statusGuard
    || params(statusGuardEnd).WFControlFlowMode !== 2
    || literalText(params(statusInvalidNotice).Text) !== ICOST_INVALID_RESPONSE_NOTICE) {
    throw new Error("iCost bridge 只允许森特 review_required 响应继续");
  }
  if (JSON.stringify(params(syncOptions).WFItems) !== JSON.stringify(ICOST_URL_BRIDGE_OPTIONS)) {
    throw new Error("iCost bridge 选择项不正确");
  }
  const expectedChoiceParameterKeys = [
    "CustomOutputName",
    "UUID",
    "WFChooseFromListActionPrompt",
    "WFInput",
  ];
  if (params(syncChoice).WFChooseFromListActionPrompt !== ICOST_BRIDGE_PROMPT
    || !hasExactAttachment(params(syncChoice).WFInput, params(syncOptions).UUID, "iCost同步选项")
    || JSON.stringify(Object.keys(params(syncChoice)).sort()) !== JSON.stringify(expectedChoiceParameterKeys)) {
    throw new Error("iCost bridge 选择动作绑定不正确");
  }
  const syncGuard = params(syncGuardStart).GroupingIdentifier;
  if (!syncGuard
    || params(syncGuardStart).WFControlFlowMode !== 0
    || params(syncGuardStart).WFCondition !== 4
    || params(syncGuardStart).WFConditionalActionString !== ICOST_BRIDGE_CHOICE
    || !hasExactConditionalInput(params(syncGuardStart).WFInput, params(syncChoice).UUID, "iCost同步决定")
    || params(syncGuardOtherwise).GroupingIdentifier !== syncGuard
    || params(syncGuardOtherwise).WFControlFlowMode !== 1
    || params(syncGuardEnd).GroupingIdentifier !== syncGuard
    || params(syncGuardEnd).WFControlFlowMode !== 2) {
    throw new Error("iCost bridge 同步条件不正确");
  }

  if (params(replayed).WFDictionaryKey !== "replayed"
    || !hasExactAttachment(params(replayed).WFInput, params(responseItem).UUID, "森特提交条目")) {
    throw new Error("iCost bridge 重放状态来源不正确");
  }
  if (JSON.stringify(params(duplicateOptions).WFItems) !== JSON.stringify(ICOST_URL_DUPLICATE_OPTIONS)) {
    throw new Error("iCost bridge 防重复选择项不正确");
  }
  const duplicatePrompt = params(duplicateChoice).WFChooseFromListActionPrompt;
  if (literalText(duplicatePrompt) !== ICOST_DUPLICATE_PROMPT
    || !hasExactAttachments(duplicatePrompt, [{
      outputUuid: params(replayed).UUID,
      outputName: "森特是否重放",
    }])
    || !hasExactAttachment(params(duplicateChoice).WFInput, params(duplicateOptions).UUID, "iCost防重复选项")
    || JSON.stringify(Object.keys(params(duplicateChoice)).sort()) !== JSON.stringify(expectedChoiceParameterKeys)) {
    throw new Error("iCost bridge 防重复提示或绑定不正确");
  }
  const duplicateGuard = params(duplicateGuardStart).GroupingIdentifier;
  if (!duplicateGuard
    || params(duplicateGuardStart).WFControlFlowMode !== 0
    || params(duplicateGuardStart).WFCondition !== 4
    || params(duplicateGuardStart).WFConditionalActionString !== ICOST_DUPLICATE_CONTINUE
    || !hasExactConditionalInput(params(duplicateGuardStart).WFInput, params(duplicateChoice).UUID, "iCost防重复确认")
    || params(duplicateGuardOtherwise).GroupingIdentifier !== duplicateGuard
    || params(duplicateGuardOtherwise).WFControlFlowMode !== 1
    || params(duplicateGuardEnd).GroupingIdentifier !== duplicateGuard
    || params(duplicateGuardEnd).WFControlFlowMode !== 2) {
    throw new Error("iCost bridge 防重复确认条件不正确");
  }

  const amount = findNamed(actual, "金额");
  const category = findNamed(actual, "最终类别");
  const subcategory = findNamed(actual, "最终子类");
  const note = findNamed(actual, "备注（可选）");
  const entryType = findNamed(actual, "已选收支");
  const expectedNoteParameterKeys = [
    "CustomOutputName",
    "UUID",
    "WFAskActionPrompt",
    "WFInputType",
  ];
  if (identifier(note.entry) !== ASK_ACTION
    || params(note.entry).WFAskActionPrompt !== "最后一步：备注（可选，点完成可跳过）"
    || params(note.entry).WFInputType !== 0
    || JSON.stringify(Object.keys(params(note.entry)).sort()) !== JSON.stringify(expectedNoteParameterKeys)) {
    throw new Error("iCost bridge 备注输入必须是无默认值、无外部绑定的本机文本输入");
  }
  if (literalText(params(book).WFTextActionText) !== ICOST_BOOK_NAME
    || !hasExactAttachments(params(book).WFTextActionText, [])) {
    throw new Error("iCost bridge 账本必须固定为出差报销");
  }
  if (literalText(params(remark).WFTextActionText) !== "子类：￼\n备注：￼"
    || !hasExactAttachments(params(remark).WFTextActionText, [
      { outputUuid: params(subcategory.entry).UUID, outputName: "最终子类" },
      { outputUuid: params(note.entry).UUID, outputName: "备注（可选）" },
    ])) {
    throw new Error("iCost bridge 备注只能绑定已选子类和本机备注");
  }
  const expectedEncodeSources = new Map([
    [amountEncode, { outputUuid: params(amount.entry).UUID, outputName: "金额" }],
    [categoryEncode, { outputUuid: params(category.entry).UUID, outputName: "最终类别" }],
    [bookEncode, { outputUuid: params(book).UUID, outputName: "iCost账本" }],
    [remarkEncode, { outputUuid: params(remark).UUID, outputName: "iCost备注原文" }],
  ]);
  for (const [encode, expectedSource] of expectedEncodeSources) {
    if (params(encode).WFEncodeMode !== "Encode"
      || !hasExactAttachment(
        params(encode).WFInput,
        expectedSource.outputUuid,
        expectedSource.outputName,
      )) {
      throw new Error("iCost URL 编码来源不正确");
    }
  }

  const entryGuard = params(entryGuardStart).GroupingIdentifier;
  if (!entryGuard
    || params(entryGuardStart).WFControlFlowMode !== 0
    || params(entryGuardStart).WFCondition !== 4
    || params(entryGuardStart).WFConditionalActionString !== "支出"
    || !hasExactConditionalInput(params(entryGuardStart).WFInput, params(entryType.entry).UUID, "已选收支")
    || params(entryGuardOtherwise).GroupingIdentifier !== entryGuard
    || params(entryGuardOtherwise).WFControlFlowMode !== 1
    || params(entryGuardEnd).GroupingIdentifier !== entryGuard
    || params(entryGuardEnd).WFControlFlowMode !== 2) {
    throw new Error("iCost bridge 收支条件不正确");
  }
  if (new Set([successGuard, statusGuard, syncGuard, duplicateGuard, entryGuard]).size !== 5) {
    throw new Error("iCost bridge 条件分组不得复用");
  }

  const encodedSources = [
    { outputUuid: params(amountEncode).UUID, outputName: "iCost金额（已编码）" },
    { outputUuid: params(categoryEncode).UUID, outputName: "iCost分类（已编码）" },
    { outputUuid: params(bookEncode).UUID, outputName: "iCost账本（已编码）" },
    { outputUuid: params(remarkEncode).UUID, outputName: "iCost备注（已编码）" },
  ];
  const assertUrl = (urlAction, expectedPath, expectedName) => {
    const urlValue = params(urlAction).WFURLActionURL;
    if (params(urlAction).CustomOutputName !== expectedName
      || literalText(urlValue) !== `${ICOST_SCHEME}${expectedPath}?amount=￼&category=￼&book=￼&remark=￼`
      || !hasExactAttachments(urlValue, encodedSources)) {
      throw new Error(`${expectedName} 路径或参数绑定不正确`);
    }
  };
  assertUrl(expenseUrl, "expense", "iCost支出URL");
  assertUrl(incomeUrl, "income", "iCost收入URL");
  if (!hasExactAttachment(params(expenseOpen).WFInput, params(expenseUrl).UUID, "iCost支出URL")
    || !hasExactAttachment(params(incomeOpen).WFInput, params(incomeUrl).UUID, "iCost收入URL")) {
    throw new Error("Open URL 未绑定对应的 iCost 收支 URL");
  }
  if (literalText(params(expenseNotice).Text) !== ICOST_EXPENSE_NOTICE
    || literalText(params(incomeNotice).Text) !== ICOST_INCOME_NOTICE
    || literalText(params(duplicateCancelNotice).Text) !== ICOST_DUPLICATE_CANCEL_NOTICE
    || literalText(params(skipNotice).Text) !== ICOST_SKIP_NOTICE) {
    throw new Error("iCost bridge 结果提示不正确");
  }

  const bridgeUrls = [expenseUrl, incomeUrl];
  const opens = [expenseOpen, incomeOpen];
  const encodes = [amountEncode, categoryEncode, bookEncode, remarkEncode];
  if (actual.filter((entry) => identifier(entry) === URL_ACTION).length !== bridgeUrls.length
    || actual.filter((entry) => identifier(entry) === OPEN_URL_ACTION).length !== opens.length
    || actual.filter((entry) => identifier(entry) === URL_ENCODE_ACTION).length !== encodes.length) {
    throw new Error("iCost bridge 包含额外 URL 或 URL Encode 动作");
  }
  if (actual.some((entry) => identifier(entry) === "is.workflow.actions.downloadurl"
    && String(params(entry).WFURL ?? "").startsWith(ICOST_SCHEME))) {
    throw new Error("iCost URL 不得伪装成 HTTP 请求");
  }

  const finalConfirm = findNamed(actual, "本机最终确认");
  const finalConfirmRange = findGuardRange(actual, ranges, params(finalConfirm.entry).UUID);
  const finalConfirmGuardStart = actual[finalConfirmRange.start];
  const cancelNotice = actual[finalConfirmRange.otherwise + 1];
  if (identifier(finalConfirm.entry) !== CHOOSE_ACTION
    || params(finalConfirmGuardStart).WFCondition !== 4
    || params(finalConfirmGuardStart).WFConditionalActionString !== "✅ 确定记录"
    || !hasExactConditionalInput(
      params(finalConfirmGuardStart).WFInput,
      params(finalConfirm.entry).UUID,
      "本机最终确认",
    )
    || finalConfirmRange.otherwise === null
    || finalConfirmRange.end - finalConfirmRange.otherwise !== 2
    || identifier(cancelNotice) !== SHOW_RESULT_ACTION
    || literalText(params(cancelNotice).Text) !== CAPTURE_CANCEL_MESSAGE) {
    throw new Error("本机最终确认守卫或取消分支不正确");
  }
  if (!(finalRequest.index > finalConfirmRange.start && finalRequest.index < finalConfirmRange.otherwise)) {
    throw new Error("森特提交必须位于本机最终确认的确定分支");
  }
  const bridgeIndexes = actual
    .map((entry, index) => (params(entry).CustomOutputName?.startsWith("iCost") || identifier(entry) === OPEN_URL_ACTION ? index : -1))
    .filter((index) => index >= 0);
  if (!bridgeIndexes.length || bridgeIndexes.some((index) => index <= finalErrorRange.otherwise || index >= finalErrorRange.end)) {
    throw new Error("iCost bridge 必须位于森特成功分支");
  }
  if (bridgeIndexes.some((index) => index <= finalConfirmRange.start || index >= finalConfirmRange.otherwise)) {
    throw new Error("iCost bridge 必须位于本机最终确认的确定分支");
  }
  if (actual.some((entry) => identifier(entry) === URL_ACTION && /x-(?:success|cancel|error)|callback|read|query/iu.test(JSON.stringify(entry)))) {
    throw new Error("iCost bridge 不得假设回调或读取协议");
  }
  const markerCredentialCount = xml.split(`Bearer ${CAPTURE_DEVICE_MARKER}`).length - 1;
  const boundCredentials = xml.match(/Bearer [A-Za-z0-9_-]{43}/gu) ?? [];
  const boundCredentialCount = boundCredentials.length;
  if (!(
    (markerCredentialCount === 3 && boundCredentialCount === 0)
    || (markerCredentialCount === 0
      && boundCredentialCount === 3
      && new Set(boundCredentials).size === 1)
  )) {
    throw new Error("三个森特请求必须使用同一个设备凭据");
  }
  const canonicalDeviceToken = markerCredentialCount === 3
    ? CAPTURE_DEVICE_MARKER
    : boundCredentials[0].slice("Bearer ".length);
  if (!isDeepStrictEqual(baseActions, canonicalV8Actions(baseActions, canonicalDeviceToken))) {
    throw new Error("V8 基础动作参数不正确或安全数据来源被改写");
  }
  if (!isDeepStrictEqual(actual, bridgeActions(baseActions).actions)) {
    throw new Error("iCost bridge 动作参数不正确或安全条件被改写");
  }
  return {
    ...baseReport,
    actionCount: actual.length,
    baseActionCount: baseActions.length,
    baseShortcutName: ICOST_URL_BRIDGE_BASE_NAME,
    baseVersion: ICOST_URL_BRIDGE_BASE_VERSION,
    bridgeActionCount: finalErrorRange.end - (finalErrorRange.otherwise + 1),
    iCostOpenAttempted: true,
    iCostReadback: false,
    iCostAtomicWithCapture: false,
    iCostQueryKeys: ["amount", "category", "book", "remark"],
    iCostQueryValuesEncoded: true,
    iCostRawOcrNotSent: true,
    iCostCredentialsPresent: false,
    iCostUrls: bridgeUrls.map((entry) => params(entry).CustomOutputName),
    iCostBookName: ICOST_BOOK_NAME,
    iCostReplayWarning: true,
    iCostSecondConfirmation: true,
    iCostRequiresResponseItemId: true,
    iCostRequiresReviewRequiredStatus: true,
    deviceCredentialMode: markerCredentialCount === 3 ? "placeholder" : "bound",
  };
}

async function materializeV8Input(inputPath, deviceToken) {
  const sourceXml = await readFile(inputPath, "utf8");
  const source = parsePlistXml(sourceXml);
  if (Array.isArray(source.WFWorkflowActions) && source.WFWorkflowActions.length >= 90) {
    assertBaseIsV8(source);
    return { plist: applyDeviceTokenToV8(source, deviceToken), cleanup: async () => {} };
  }
  // The supplied iCost shortcut is a four-action legacy source. Convert it to
  // the already-tested V8 full-OCR flow in a private temporary directory; no
  // runtime credential or screenshot bytes are written to the repository.
  if (source.WFWorkflowActions?.length !== 4) {
    throw new Error("输入既不是四动作 iCost 源文件，也不是 V8 unsigned 制品");
  }
  const directory = await mkdtemp(join(tmpdir(), "icost-url-bridge-base-"));
  const convertedPath = join(directory, "v8.unsigned.shortcut");
  await writeFile(join(directory, "source.shortcut"), sourceXml, { mode: 0o600 });
  await convertIcostCaptureShortcut({ inputPath: join(directory, "source.shortcut"), outputPath: convertedPath, deviceToken });
  const plist = parsePlistXml(await readFile(convertedPath, "utf8"));
  return { plist, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

export async function buildIcostUrlBridgeShortcut({
  inputPath,
  outputPath,
  deviceToken = CAPTURE_DEVICE_MARKER,
} = {}) {
  if (!inputPath || !outputPath) throw new Error("inputPath and outputPath are required");
  if (deviceToken !== CAPTURE_DEVICE_MARKER && !/^[A-Za-z0-9_-]{43}$/u.test(deviceToken)) {
    throw new Error("deviceToken must be an account-bound Shortcut device credential");
  }
  const resolvedInputPath = resolve(inputPath);
  const resolvedOutputPath = resolve(outputPath);
  if (resolvedInputPath === resolvedOutputPath) {
    throw new Error("bridge 输出不得覆盖输入快捷指令");
  }
  const materialized = await materializeV8Input(resolvedInputPath, deviceToken);
  try {
    assertBaseIsV8(materialized.plist);
    const built = bridgeActions(materialized.plist.WFWorkflowActions);
    const plist = { ...materialized.plist, WFWorkflowActions: built.actions };
    const xml = serializePlistXml(plist);
    const report = inspectIcostUrlBridgeShortcutXml(xml);
    await writeFile(resolvedOutputPath, xml, { encoding: "utf8", mode: 0o600 });
    await chmod(resolvedOutputPath, 0o600);
    return { outputPath: resolvedOutputPath, report };
  } finally {
    await materialized.cleanup();
  }
}

function parseCliArguments(argv) {
  const result = {};
  for (const argument of argv) {
    const match = /^--(input|output)=(.+)$/u.exec(argument);
    if (!match) throw new Error(`Unknown argument: ${argument}`);
    const key = match[1] === "input" ? "inputPath" : "outputPath";
    result[key] = resolve(match[2]);
  }
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const options = parseCliArguments(process.argv.slice(2));
  const deviceToken = process.env.SHORTCUT_DEVICE_TOKEN?.trim();
  buildIcostUrlBridgeShortcut({
    ...options,
    ...(deviceToken ? { deviceToken } : {}),
  })
    .then(({ outputPath, report }) => process.stdout.write(`${JSON.stringify({ outputPath, ...report }, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
