import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "node:test";

import { parsePlistXml, serializePlistXml } from "../../integrations/icost-shortcut/plist-xml.mjs";
import {
  ICOST_URL_BRIDGE_BASE_NAME,
  ICOST_URL_BRIDGE_BASE_VERSION,
  ICOST_URL_BRIDGE_OPTIONS,
  ICOST_URL_BRIDGE_SHORTCUT_NAME,
  ICOST_URL_DUPLICATE_OPTIONS,
  buildIcostUrlBridgeShortcut,
  inspectIcostUrlBridgeShortcutXml,
} from "../../integrations/shortcut/build-icost-url-bridge-shortcut.mjs";
import {
  CAPTURE_DEVICE_MARKER,
  convertIcostCaptureShortcut,
} from "../../integrations/shortcut/convert-icost-capture-shortcut.mjs";
import { signIcostUrlBridgeShortcut } from "../../integrations/shortcut/sign-icost-url-bridge-shortcut.mjs";

const temporaryDirectories = [];
const repeatChars = (value) => value.repeat(43);
const SOURCE_SCREEN_UUID = "00000000-0000-4000-8000-000000000001";
const SOURCE_CROP_UUID = "00000000-0000-4000-8000-000000000002";
const SOURCE_OCR_UUID = "00000000-0000-4000-8000-000000000003";
const SOURCE_ICOST_UUID = "00000000-0000-4000-8000-000000000004";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

function sourcePlist() {
  return {
    WFWorkflowActions: [
      {
        WFWorkflowActionIdentifier: "is.workflow.actions.takescreenshot",
        WFWorkflowActionParameters: { UUID: SOURCE_SCREEN_UUID },
      },
      {
        WFWorkflowActionIdentifier: "is.workflow.actions.image.crop",
        WFWorkflowActionParameters: {
          UUID: SOURCE_CROP_UUID,
          WFImageCropHeight: {
            Value: {
              Aggrandizements: [{ PropertyName: "Height", Type: "WFPropertyVariableAggrandizement" }],
              OutputName: "截屏",
              OutputUUID: SOURCE_SCREEN_UUID,
              Type: "ActionOutput",
            },
            WFSerializationType: "WFTextTokenAttachment",
          },
          WFImageCropPosition: "Custom",
          WFImageCropWidth: {
            Value: {
              Aggrandizements: [{ PropertyName: "Width", Type: "WFPropertyVariableAggrandizement" }],
              OutputName: "截屏",
              OutputUUID: SOURCE_SCREEN_UUID,
              Type: "ActionOutput",
            },
            WFSerializationType: "WFTextTokenAttachment",
          },
          WFImageCropY: "120",
          WFInput: {
            Value: { OutputName: "截屏", OutputUUID: SOURCE_SCREEN_UUID, Type: "ActionOutput" },
            WFSerializationType: "WFTextTokenAttachment",
          },
        },
      },
      {
        WFWorkflowActionIdentifier: "is.workflow.actions.extracttextfromimage",
        WFWorkflowActionParameters: {
          UUID: SOURCE_OCR_UUID,
          WFImage: {
            Value: { OutputName: "裁剪后的图像", OutputUUID: SOURCE_CROP_UUID, Type: "ActionOutput" },
            WFSerializationType: "WFTextTokenAttachment",
          },
        },
      },
      {
        WFWorkflowActionIdentifier: "com.gostraight.smallAccountBook.ICAISnapshotShortcutV7",
        WFWorkflowActionParameters: {
          UUID: SOURCE_ICOST_UUID,
          rawText: {
            Value: {
              attachmentsByRange: {
                "{0, 1}": {
                  OutputName: "图像中的文本",
                  OutputUUID: SOURCE_OCR_UUID,
                  Type: "ActionOutput",
                },
              },
              string: "￼",
            },
            WFSerializationType: "WFTextTokenString",
          },
        },
      },
    ],
    WFWorkflowClientVersion: "4711",
    WFWorkflowTypes: ["Watch", "WFWorkflowTypeShowInSearch"],
  };
}

function actionParameters(entry) {
  return entry?.WFWorkflowActionParameters ?? {};
}

function outputUuid(value) {
  if (value?.WFSerializationType === "WFTextTokenAttachment") return value.Value?.OutputUUID;
  const values = Object.values(value?.Value?.attachmentsByRange ?? {});
  return values.length === 1 ? values[0]?.OutputUUID : undefined;
}

function actionByName(actions, name) {
  const matches = actions.filter((entry) => actionParameters(entry).CustomOutputName === name);
  assert.equal(matches.length, 1, `expected one action named ${name}`);
  return matches[0];
}

function authorizationValue(action) {
  const items = actionParameters(action).WFHTTPHeaders?.Value?.WFDictionaryFieldValueItems ?? [];
  return items.find((item) => item.WFKey?.Value?.string === "Authorization")?.WFValue;
}

function guardForAction(actions, guardedAction) {
  const matches = actions.filter((entry) => (
    entry.WFWorkflowActionIdentifier === "is.workflow.actions.conditional"
    && actionParameters(entry).WFControlFlowMode === 0
    && outputUuid(actionParameters(entry).WFInput?.Variable) === actionParameters(guardedAction).UUID
  ));
  assert.equal(matches.length, 1, "expected one guard for the named action");
  return matches[0];
}

async function buildTemporaryBridge(label, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), `${label}-`));
  temporaryDirectories.push(directory);
  const inputPath = join(directory, "source.shortcut");
  const outputPath = join(directory, "bridge.unsigned.shortcut");
  await writeFile(inputPath, serializePlistXml(sourcePlist()), { mode: 0o600 });
  await buildIcostUrlBridgeShortcut({ inputPath, outputPath, ...options });
  const xml = await readFile(outputPath, "utf8");
  return { directory, inputPath, outputPath, xml, plist: parsePlistXml(xml) };
}

describe("官方 iCost URL bridge 快捷指令", () => {
  it("keeps the V8 confirmation/capture flow and opens only an explicitly selected iCost URL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shortcut-icost-url-bridge-"));
    temporaryDirectories.push(directory);
    const inputPath = join(directory, "source.shortcut");
    const outputPath = join(directory, "bridge.unsigned.shortcut");
    await writeFile(inputPath, serializePlistXml(sourcePlist()), { mode: 0o600 });

    const { report } = await buildIcostUrlBridgeShortcut({ inputPath, outputPath });
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
    assert.equal(report.actionCount, 141);
    assert.equal(report.baseActionCount, 101);
    assert.equal(report.baseShortcutName, "智能截图记账（三级菜单待确认版V8·全屏OCR）");
    assert.equal(report.baseVersion, "V8");
    assert.equal(ICOST_URL_BRIDGE_SHORTCUT_NAME, "智能截图记账（V8·全屏OCR·官方iCost桥接版）");
    assert.equal(ICOST_URL_BRIDGE_BASE_NAME, report.baseShortcutName);
    assert.equal(ICOST_URL_BRIDGE_BASE_VERSION, report.baseVersion);
    assert.equal(report.iCostOpenAttempted, true);
    assert.equal(report.iCostReadback, false);
    assert.equal(report.iCostAtomicWithCapture, false);
    assert.deepEqual(report.iCostQueryKeys, ["amount", "category", "book", "remark"]);
    assert.equal(report.iCostQueryValuesEncoded, true);
    assert.equal(report.iCostRawOcrNotSent, true);
    assert.equal(report.iCostCredentialsPresent, false);
    assert.equal(report.iCostBookName, "出差报销");
    assert.equal(report.iCostReplayWarning, true);
    assert.equal(report.iCostSecondConfirmation, true);
    assert.equal(report.iCostRequiresResponseItemId, true);
    assert.equal(report.iCostRequiresReviewRequiredStatus, true);
    assert.equal(report.deviceCredentialMode, "placeholder");
    assert.deepEqual(ICOST_URL_BRIDGE_OPTIONS, [
      "仅提交森特（不打开 iCost）",
      "同时打开 iCost 添加账单",
    ]);
    assert.deepEqual(ICOST_URL_DUPLICATE_OPTIONS, [
      "取消 iCost 写入",
      "我确认尚未在 iCost 保存，继续",
    ]);

    const xml = await readFile(outputPath, "utf8");
    const inspected = inspectIcostUrlBridgeShortcutXml(xml);
    assert.equal(inspected.actionCount, 141);
    assert.equal(inspected.baseActionCount, 101);
    assert.equal(inspected.baseVersion, "V8");
    assert.equal(inspected.bridgeActionCount, 39);
    assert.deepEqual(inspected.iCostUrls, ["iCost支出URL", "iCost收入URL"]);
    assert.doesNotMatch(xml, /ICAISnapshotShortcutV7/u);
    assert.doesNotMatch(xml, /bookkeeping-capture-inline|森特账号|森特密码/u);
    assert.doesNotMatch(xml, /x-success|x-cancel|x-error|callback|readback|query/u);

    const plist = parsePlistXml(xml);
    const actions = plist.WFWorkflowActions;
    const actionUuids = actions.map((entry) => actionParameters(entry).UUID).filter(Boolean);
    const groupingIdentifiers = actions.map((entry) => actionParameters(entry).GroupingIdentifier).filter(Boolean);
    assert.equal(new Set(actionUuids).size, actionUuids.length);
    assert.equal(groupingIdentifiers.some((identifier) => actionUuids.includes(identifier)), false);
    const urls = actions.filter((entry) => entry.WFWorkflowActionIdentifier === "is.workflow.actions.url");
    const opens = actions.filter((entry) => entry.WFWorkflowActionIdentifier === "is.workflow.actions.openurl");
    const encodes = actions.filter((entry) => entry.WFWorkflowActionIdentifier === "is.workflow.actions.urlencode");
    assert.equal(urls.length, 2);
    assert.equal(opens.length, 2);
    assert.equal(encodes.length, 4);
    assert.deepEqual(encodes.map((entry) => actionParameters(entry).WFEncodeMode), ["Encode", "Encode", "Encode", "Encode"]);
    for (const open of opens) {
      const targetUuid = outputUuid(actionParameters(open).WFInput);
      assert.equal(actions.filter((entry) => actionParameters(entry).UUID === targetUuid).length, 1);
      assert.equal(actions.find((entry) => actionParameters(entry).UUID === targetUuid).WFWorkflowActionIdentifier, "is.workflow.actions.url");
    }
    for (const url of urls) {
      const value = actionParameters(url).WFURLActionURL;
      assert.match(value.Value.string, /^iCost:\/\/(?:expense|income)\?amount=￼&category=￼&book=￼&remark=￼$/u);
      assert.equal(Object.values(value.Value.attachmentsByRange).length, 4);
    }
  });

  it("rejects a non-V8 base instead of silently retaining iCost's private action", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shortcut-icost-url-bridge-invalid-"));
    temporaryDirectories.push(directory);
    const inputPath = join(directory, "invalid.shortcut");
    const outputPath = join(directory, "bridge.unsigned.shortcut");
    const invalid = sourcePlist();
    invalid.WFWorkflowActions.push({
      WFWorkflowActionIdentifier: "is.workflow.actions.comment",
      WFWorkflowActionParameters: { WFCommentActionText: "unexpected" },
    });
    await writeFile(inputPath, serializePlistXml(invalid), { mode: 0o600 });
    await assert.rejects(
      () => buildIcostUrlBridgeShortcut({ inputPath, outputPath }),
      /四动作 iCost 源文件，也不是 V8 unsigned 制品/u,
    );
  });

  it("rejects a bridge whose URL action is changed to an HTTP or callback target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shortcut-icost-url-bridge-tamper-"));
    temporaryDirectories.push(directory);
    const inputPath = join(directory, "source.shortcut");
    const outputPath = join(directory, "bridge.unsigned.shortcut");
    await writeFile(inputPath, serializePlistXml(sourcePlist()), { mode: 0o600 });
    await buildIcostUrlBridgeShortcut({ inputPath, outputPath });
    const plist = parsePlistXml(await readFile(outputPath, "utf8"));
    const url = plist.WFWorkflowActions.find(
      (entry) => actionParameters(entry).CustomOutputName === "iCost支出URL",
    );
    url.WFWorkflowActionParameters.WFURLActionURL = {
      Value: { string: "https://example.invalid/?x=￼", attachmentsByRange: {} },
      WFSerializationType: "WFTextTokenString",
    };
    assert.throws(
      () => inspectIcostUrlBridgeShortcutXml(serializePlistXml(plist)),
      /iCost支出URL 路径或参数绑定不正确/u,
    );
  });

  it("rebinds only the three V8 marker credentials when a device token is supplied", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shortcut-icost-url-bridge-v8-token-"));
    temporaryDirectories.push(directory);
    const sourcePath = join(directory, "source.shortcut");
    const v8Path = join(directory, "v8.unsigned.shortcut");
    const outputPath = join(directory, "bridge.unsigned.shortcut");
    const boundValue = repeatChars("A");
    await writeFile(sourcePath, serializePlistXml(sourcePlist()), { mode: 0o600 });
    await convertIcostCaptureShortcut({ inputPath: sourcePath, outputPath: v8Path });

    await buildIcostUrlBridgeShortcut({ inputPath: v8Path, outputPath, deviceToken: boundValue });
    const xml = await readFile(outputPath, "utf8");
    assert.equal(inspectIcostUrlBridgeShortcutXml(xml).deviceCredentialMode, "bound");
    assert.equal((xml.match(new RegExp(`Bearer ${boundValue}`, "gu")) ?? []).length, 3);
    assert.equal(xml.includes(`Bearer ${CAPTURE_DEVICE_MARKER}`), false);
    assert.doesNotMatch(xml, /ICAISnapshotShortcutV7/u);
  });

  it("does not overwrite an already-bound V8 artifact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shortcut-icost-url-bridge-v8-bound-"));
    temporaryDirectories.push(directory);
    const sourcePath = join(directory, "source.shortcut");
    const v8Path = join(directory, "v8.unsigned.shortcut");
    const outputPath = join(directory, "bridge.unsigned.shortcut");
    const originalValue = repeatChars("B");
    const replacementValue = repeatChars("C");
    await writeFile(sourcePath, serializePlistXml(sourcePlist()), { mode: 0o600 });
      await convertIcostCaptureShortcut({ inputPath: sourcePath, outputPath: v8Path, deviceToken: originalValue });

    await assert.rejects(
      () => buildIcostUrlBridgeShortcut({ inputPath: v8Path, outputPath, deviceToken: replacementValue }),
      /恰好 3 个设备凭据占位符/u,
    );
  });

  it("rejects a reversed outer choice guard that could open iCost from the skip option", async () => {
    const { plist } = await buildTemporaryBridge("shortcut-icost-url-bridge-guard");
    const actions = plist.WFWorkflowActions;
    const choice = actionByName(actions, "iCost同步决定");
    const guard = guardForAction(actions, choice);
    actionParameters(guard).WFConditionalActionString = ICOST_URL_BRIDGE_OPTIONS[0];
    assert.throws(
      () => inspectIcostUrlBridgeShortcutXml(serializePlistXml(plist)),
      /同步条件不正确/u,
    );
  });

  it("rejects a remark encoder rebound to OCR text", async () => {
    const { plist } = await buildTemporaryBridge("shortcut-icost-url-bridge-encode");
    const actions = plist.WFWorkflowActions;
    const remarkEncode = actionByName(actions, "iCost备注（已编码）");
    const ocr = actionByName(actions, "OCR纯文本");
    actionParameters(remarkEncode).WFInput = {
      Value: {
        OutputUUID: actionParameters(ocr).UUID,
        OutputName: "OCR纯文本",
        Type: "ActionOutput",
      },
      WFSerializationType: "WFTextTokenAttachment",
    };
    assert.throws(
      () => inspectIcostUrlBridgeShortcutXml(serializePlistXml(plist)),
      /iCost URL 编码来源不正确/u,
    );
  });

  it("rejects swapped expense and income URL paths", async () => {
    const { plist } = await buildTemporaryBridge("shortcut-icost-url-bridge-paths");
    const actions = plist.WFWorkflowActions;
    const expenseUrl = actionByName(actions, "iCost支出URL");
    const incomeUrl = actionByName(actions, "iCost收入URL");
    const expenseValue = structuredClone(actionParameters(expenseUrl).WFURLActionURL);
    actionParameters(expenseUrl).WFURLActionURL = structuredClone(actionParameters(incomeUrl).WFURLActionURL);
    actionParameters(incomeUrl).WFURLActionURL = expenseValue;
    assert.throws(
      () => inspectIcostUrlBridgeShortcutXml(serializePlistXml(plist)),
      /iCost支出URL 路径或参数绑定不正确/u,
    );
  });

  it("rejects an extra workflow action outside the exact V8 and bridge contracts", async () => {
    const { plist } = await buildTemporaryBridge("shortcut-icost-url-bridge-extra-action");
    plist.WFWorkflowActions.push({
      WFWorkflowActionIdentifier: "is.workflow.actions.runworkflow",
      WFWorkflowActionParameters: { UUID: "00000000-0000-4000-8000-00000000FFFF" },
    });
    assert.throws(
      () => inspectIcostUrlBridgeShortcutXml(serializePlistXml(plist)),
      /V8 基础动作序列不正确或包含额外动作/u,
    );
  });

  it("rejects different credentials across the three Sentelligent requests", async () => {
    const { plist } = await buildTemporaryBridge("shortcut-icost-url-bridge-mixed-token", {
      deviceToken: "A".repeat(43),
    });
    const requestActions = plist.WFWorkflowActions.filter(
      (entry) => entry.WFWorkflowActionIdentifier === "is.workflow.actions.downloadurl",
    );
    const authorizationValues = requestActions.map(authorizationValue).filter(Boolean);
    assert.equal(authorizationValues.length, 3);
    authorizationValues[1].Value.string = `Bearer ${"D".repeat(43)}`;
    assert.throws(
      () => inspectIcostUrlBridgeShortcutXml(serializePlistXml(plist)),
      /三个森特请求必须使用同一个设备凭据/u,
    );
  });

  it("rejects import questions that could rewrite verified parameters", async () => {
    const { plist } = await buildTemporaryBridge("shortcut-icost-url-bridge-import-question");
    plist.WFWorkflowImportQuestions = [{ ActionIndex: 0, ParameterKey: "WFInput" }];
    assert.throws(
      () => inspectIcostUrlBridgeShortcutXml(serializePlistXml(plist)),
      /不允许导入问题改写已验证参数/u,
    );
  });

  it("refuses to overwrite the input Shortcut", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shortcut-icost-url-bridge-overwrite-"));
    temporaryDirectories.push(directory);
    const inputPath = join(directory, "source.shortcut");
    await writeFile(inputPath, serializePlistXml(sourcePlist()), { mode: 0o600 });
    await assert.rejects(
      () => buildIcostUrlBridgeShortcut({ inputPath, outputPath: inputPath }),
      /bridge 输出不得覆盖输入快捷指令/u,
    );
  });

  it("rejects URL token attachments moved to incorrect string offsets", async () => {
    const { plist } = await buildTemporaryBridge("shortcut-icost-url-bridge-offset");
    const expenseUrl = actionByName(plist.WFWorkflowActions, "iCost支出URL");
    const attachments = actionParameters(expenseUrl).WFURLActionURL.Value.attachmentsByRange;
    const [firstKey] = Object.keys(attachments);
    const firstValue = attachments[firstKey];
    delete attachments[firstKey];
    attachments["{0, 1}"] = firstValue;
    assert.throws(
      () => inspectIcostUrlBridgeShortcutXml(serializePlistXml(plist)),
      /iCost支出URL 路径或参数绑定不正确/u,
    );
  });

  it("rejects an inverted final-error guard that could open iCost after a failed capture", async () => {
    const { plist } = await buildTemporaryBridge("shortcut-icost-url-bridge-error-condition");
    const actions = plist.WFWorkflowActions;
    const finalError = actionByName(actions, "最终提交错误");
    actionParameters(guardForAction(actions, finalError)).WFCondition = 101;
    assert.throws(
      () => inspectIcostUrlBridgeShortcutXml(serializePlistXml(plist)),
      /最终提交错误守卫必须仅在 error 有值时进入失败分支/u,
    );
  });

  it("rejects a final-error lookup changed away from the response error field", async () => {
    const { plist } = await buildTemporaryBridge("shortcut-icost-url-bridge-error-key");
    const finalError = actionByName(plist.WFWorkflowActions, "最终提交错误");
    actionParameters(finalError).WFDictionaryKey = "not_error";
    assert.throws(
      () => inspectIcostUrlBridgeShortcutXml(serializePlistXml(plist)),
      /最终提交错误必须读取森特提交响应的 error 字段/u,
    );
  });

  it("rejects an inverted local confirmation guard", async () => {
    const { plist } = await buildTemporaryBridge("shortcut-icost-url-bridge-confirm-condition");
    const actions = plist.WFWorkflowActions;
    const finalConfirm = actionByName(actions, "本机最终确认");
    actionParameters(guardForAction(actions, finalConfirm)).WFConditionalActionString = "❌ 取消记录";
    assert.throws(
      () => inspectIcostUrlBridgeShortcutXml(serializePlistXml(plist)),
      /本机最终确认守卫或取消分支不正确/u,
    );
  });

  it("rejects an OCR-backed default value injected into the local note prompt", async () => {
    const { plist } = await buildTemporaryBridge("shortcut-icost-url-bridge-note-default");
    const actions = plist.WFWorkflowActions;
    const note = actionByName(actions, "备注（可选）");
    const ocr = actionByName(actions, "OCR纯文本");
    actionParameters(note).WFAskActionDefaultAnswer = {
      Value: {
        OutputUUID: actionParameters(ocr).UUID,
        OutputName: "OCR纯文本",
        Type: "ActionOutput",
      },
      WFSerializationType: "WFTextTokenAttachment",
    };
    assert.throws(
      () => inspectIcostUrlBridgeShortcutXml(serializePlistXml(plist)),
      /备注输入必须是无默认值、无外部绑定的本机文本输入/u,
    );
  });

  it("rejects raw OCR rebound into a base value later sent to iCost", async () => {
    const { plist } = await buildTemporaryBridge("shortcut-icost-url-bridge-base-lineage");
    const actions = plist.WFWorkflowActions;
    const amount = actionByName(actions, "金额");
    const ocr = actionByName(actions, "OCR纯文本");
    actionParameters(amount).WFInput = {
      Value: {
        OutputUUID: actionParameters(ocr).UUID,
        OutputName: "OCR纯文本",
        Type: "ActionOutput",
      },
      WFSerializationType: "WFTextTokenAttachment",
    };
    assert.throws(
      () => inspectIcostUrlBridgeShortcutXml(serializePlistXml(plist)),
      /V8 基础动作参数不正确或安全数据来源被改写/u,
    );
  });

  it("rejects a tampered screenshot crop input instead of self-canonicalizing it", async () => {
    const { plist } = await buildTemporaryBridge("shortcut-icost-url-bridge-prefix");
    const crop = plist.WFWorkflowActions[1];
    actionParameters(crop).WFInput = {
      Value: { string: "attacker-controlled text" },
      WFSerializationType: "WFTextTokenString",
    };
    assert.throws(
      () => inspectIcostUrlBridgeShortcutXml(serializePlistXml(plist)),
      /裁剪动作参数不符合受信源快捷指令合同/u,
    );
  });

  it("rejects malformed UUIDs in the trusted screenshot prefix", async () => {
    const { plist } = await buildTemporaryBridge("shortcut-icost-url-bridge-prefix-uuid");
    actionParameters(plist.WFWorkflowActions[1]).UUID = "not-a-uuid";
    assert.throws(
      () => inspectIcostUrlBridgeShortcutXml(serializePlistXml(plist)),
      /裁剪动作参数不符合受信源快捷指令合同/u,
    );
  });

  it("rejects multi-select or select-all parameters on both iCost choices", async () => {
    for (const name of ["iCost同步决定", "iCost防重复确认"]) {
      const { plist } = await buildTemporaryBridge(`shortcut-icost-url-bridge-multiselect-${name}`);
      const choice = actionByName(plist.WFWorkflowActions, name);
      actionParameters(choice).WFChooseFromListActionSelectMultiple = true;
      actionParameters(choice).WFChooseFromListActionSelectAll = true;
      assert.throws(
        () => inspectIcostUrlBridgeShortcutXml(serializePlistXml(plist)),
        /选择动作绑定不正确|防重复提示或绑定不正确/u,
      );
    }
  });

  it("rejects a disguised variable input on the outer iCost choice", async () => {
    const { plist } = await buildTemporaryBridge("shortcut-icost-url-bridge-choice-input");
    const actions = plist.WFWorkflowActions;
    const options = actionByName(actions, "iCost同步选项");
    const choice = actionByName(actions, "iCost同步决定");
    actionParameters(choice).WFInput = {
      Value: {
        OutputUUID: actionParameters(options).UUID,
        OutputName: "iCost同步选项",
        Type: "Variable",
        VariableName: "shortcut_category_v7",
      },
      WFSerializationType: "WFTextTokenAttachment",
    };
    assert.throws(
      () => inspectIcostUrlBridgeShortcutXml(serializePlistXml(plist)),
      /iCost bridge 选择动作绑定不正确/u,
    );
  });

  it("rejects property aggrandizements added to an iCost URL token", async () => {
    const { plist } = await buildTemporaryBridge("shortcut-icost-url-bridge-url-property");
    const expenseUrl = actionByName(plist.WFWorkflowActions, "iCost支出URL");
    const attachments = actionParameters(expenseUrl).WFURLActionURL.Value.attachmentsByRange;
    const [firstValue] = Object.values(attachments);
    firstValue.Aggrandizements = [{
      PropertyName: "Name",
      Type: "WFPropertyVariableAggrandizement",
    }];
    assert.throws(
      () => inspectIcostUrlBridgeShortcutXml(serializePlistXml(plist)),
      /iCost支出URL 路径或参数绑定不正确/u,
    );
  });

  it("rejects weakening either Sentelligent success-response guard", async () => {
    {
      const { plist } = await buildTemporaryBridge("shortcut-icost-url-bridge-item-id-guard");
      const actions = plist.WFWorkflowActions;
      const itemId = actionByName(actions, "森特提交条目ID");
      actionParameters(guardForAction(actions, itemId)).WFCondition = 101;
      assert.throws(
        () => inspectIcostUrlBridgeShortcutXml(serializePlistXml(plist)),
        /item.id 有值后才允许继续/u,
      );
    }
    {
      const { plist } = await buildTemporaryBridge("shortcut-icost-url-bridge-status-guard");
      const actions = plist.WFWorkflowActions;
      const status = actionByName(actions, "森特提交条目状态");
      actionParameters(guardForAction(actions, status)).WFConditionalActionString = "accepted";
      assert.throws(
        () => inspectIcostUrlBridgeShortcutXml(serializePlistXml(plist)),
        /只允许森特 review_required 响应继续/u,
      );
    }
  });

  it("refuses every placeholder artifact and signs only a bound artifact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shortcut-icost-url-bridge-sign-"));
    temporaryDirectories.push(directory);
    const inputPath = join(directory, "source.shortcut");
    const unsignedPath = join(directory, "bridge.unsigned.shortcut");
    const signedPath = join(directory, "bridge.shortcut");
    await writeFile(inputPath, serializePlistXml(sourcePlist()), { mode: 0o600 });
    await buildIcostUrlBridgeShortcut({ inputPath, outputPath: unsignedPath });

    const signer = async (_binary, argumentsList) => {
      const outputIndex = argumentsList.indexOf("--output");
      await writeFile(argumentsList[outputIndex + 1], Buffer.from("AEA1test"));
    };
    await assert.rejects(
      () => signIcostUrlBridgeShortcut({
        inputPath: unsignedPath,
        outputPath: signedPath,
        platform: "darwin",
        shortcutsBinary: "/test/shortcuts",
        runSigner: signer,
      }),
      /最终签名只接受已绑定设备凭据/u,
    );

    await buildIcostUrlBridgeShortcut({
      inputPath,
      outputPath: unsignedPath,
      deviceToken: "E".repeat(43),
    });
    const report = await signIcostUrlBridgeShortcut({
      inputPath: unsignedPath,
      outputPath: signedPath,
      platform: "darwin",
      shortcutsBinary: "/test/shortcuts",
      runSigner: signer,
    });
    assert.equal(report.actionCount, 141);
    assert.equal(report.bridgeActionCount, 39);
    assert.deepEqual(report.iCostUrls, ["iCost支出URL", "iCost收入URL"]);
    assert.equal(report.iCostReadback, false);
    assert.equal(report.iCostAtomicWithCapture, false);
    assert.equal(report.deviceCredentialMode, "bound");
    assert.equal(report.requiresSignedPayloadReinspection, true);
    assert.equal((await stat(signedPath)).mode & 0o777, 0o600);
  });
});
