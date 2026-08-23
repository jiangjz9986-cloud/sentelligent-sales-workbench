import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { parsePlistXml, serializePlistXml } from "../../integrations/icost-shortcut/plist-xml.mjs";
import {
  CAPTURE_DEVICE_ENDPOINT,
  CAPTURE_DEVICE_MARKER,
  convertIcostCaptureShortcut,
  inspectConvertedIcostCaptureShortcutXml,
} from "../../integrations/shortcut/convert-icost-capture-shortcut.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function sourcePlist() {
  return {
    WFWorkflowActions: [
      { WFWorkflowActionIdentifier: "is.workflow.actions.takescreenshot", WFWorkflowActionParameters: { UUID: "source-screen" } },
      { WFWorkflowActionIdentifier: "is.workflow.actions.image.crop", WFWorkflowActionParameters: { UUID: "source-crop" } },
      { WFWorkflowActionIdentifier: "is.workflow.actions.extracttextfromimage", WFWorkflowActionParameters: { UUID: "source-ocr" } },
      {
        WFWorkflowActionIdentifier: "com.gostraight.smallAccountBook.ICAISnapshotShortcutV7",
        WFWorkflowActionParameters: {
          UUID: "source-icost",
          rawText: {
            Value: {
              attachmentsByRange: {
                "{0, 1}": {
                  OutputName: "图像中的文本",
                  OutputUUID: "source-ocr",
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

describe("旧 iCost 智能截图快捷指令转换器", () => {
  it("preserves screenshot OCR and replaces only the final iCost write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shortcut-icost-converter-"));
    temporaryDirectories.push(directory);
    const inputPath = join(directory, "source.shortcut");
    const outputPath = join(directory, "converted.shortcut");
    await writeFile(inputPath, serializePlistXml(sourcePlist()), { mode: 0o600 });
    const { report } = await convertIcostCaptureShortcut({ inputPath, outputPath });
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
    assert.deepEqual(report, {
      actionCount: 101,
      endpoint: CAPTURE_DEVICE_ENDPOINT,
      previewEndpoint: "https://82.156.210.199/api/integrations/shortcut/bookkeeping-capture-preview",
      preservesCapturePrefix: true,
      preservesIcostOcrText: true,
      coercesOcrThroughTextAction: true,
      usesFullScreenshotOcrFallback: true,
      usesServerDerivedIdempotency: true,
      removesIcostWrite: true,
      hasInlineCredentials: false,
      hasDeviceCredential: true,
      hasFailureNotice: true,
      hasManualAmountFallback: true,
      hasThreeLevelMenus: true,
      hasOptionalNote: true,
      hasLocalFinalConfirmation: true,
      finalSubmissionUsesSummaryOnly: true,
      hasSuccessReceipt: false,
      payloadKeys: ["text", "selection_path", "amount_cents", "note", "captured_at", "source"],
    });
    const xml = await readFile(outputPath, "utf8");
    assert.match(xml, new RegExp(CAPTURE_DEVICE_MARKER, "u"));
    assert.doesNotMatch(xml, /森特账号|森特密码|bookkeeping-capture-inline/u);
    assert.doesNotMatch(xml, /idempotency_key|source_id|截图记账ID|format\.date/u);
    assert.doesNotMatch(xml, /ICAISnapshotShortcutV7/u);
    assert.match(xml, /WFTextTokenString/u);
    const converted = parsePlistXml(xml);
    const previewRequest = converted.WFWorkflowActions.find(
      (entry) => entry.WFWorkflowActionParameters?.CustomOutputName === "金额预览响应",
    );
    const previewText = previewRequest.WFWorkflowActionParameters.WFJSONValues
      .Value.WFDictionaryFieldValueItems[0].WFValue;
    assert.equal(previewText.WFSerializationType, "WFTextTokenString");
    assert.equal(
      previewText.Value.attachmentsByRange["{0, 1}"].OutputName,
      "OCR纯文本",
    );
    const convertedActions = converted.WFWorkflowActions;
    const fullScreenshotOcr = convertedActions.find(
      (entry) => entry.WFWorkflowActionParameters?.CustomOutputName === "全屏OCR",
    );
    assert.equal(fullScreenshotOcr.WFWorkflowActionIdentifier, "is.workflow.actions.extracttextfromimage");
    assert.equal(
      fullScreenshotOcr.WFWorkflowActionParameters.WFImage.Value.OutputUUID,
      convertedActions[0].WFWorkflowActionParameters.UUID,
    );
    const mergedText = convertedActions.find(
      (entry) => entry.WFWorkflowActionParameters?.CustomOutputName === "OCR纯文本",
    );
    assert.deepEqual(
      Object.values(mergedText.WFWorkflowActionParameters.WFTextActionText.Value.attachmentsByRange)
        .map((item) => item.OutputUUID),
      [convertedActions[2].WFWorkflowActionParameters.UUID, fullScreenshotOcr.WFWorkflowActionParameters.UUID],
    );
    assert.deepEqual(inspectConvertedIcostCaptureShortcutXml(xml), report);
  });

  it("embeds a valid device credential without account or password fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shortcut-icost-device-converter-"));
    temporaryDirectories.push(directory);
    const inputPath = join(directory, "source.shortcut");
    const outputPath = join(directory, "converted.shortcut");
    const fixture = "d".repeat(43);
    await writeFile(inputPath, serializePlistXml(sourcePlist()), { mode: 0o600 });
    const { report } = await convertIcostCaptureShortcut({
      inputPath,
      outputPath,
      deviceToken: fixture,
    });
    const xml = await readFile(outputPath, "utf8");
    assert.equal(report.hasDeviceCredential, true);
    assert.match(xml, new RegExp(`Bearer ${fixture}`, "u"));
    assert.doesNotMatch(xml, /<string>account<\/string>|<string>password<\/string>/u);
    await assert.rejects(() => convertIcostCaptureShortcut({
      inputPath,
      outputPath,
      deviceToken: "too-short",
    }), /deviceToken/u);
  });

  it("rejects extra actions and non-canonical endpoints", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shortcut-icost-converter-invalid-"));
    temporaryDirectories.push(directory);
    const inputPath = join(directory, "source.shortcut");
    const outputPath = join(directory, "converted.shortcut");
    const plist = sourcePlist();
    plist.WFWorkflowActions.splice(3, 0, {
      WFWorkflowActionIdentifier: "is.workflow.actions.choosefromlist",
      WFWorkflowActionParameters: { UUID: "unexpected-picker" },
    });
    await writeFile(inputPath, serializePlistXml(plist), { mode: 0o600 });
    await assert.rejects(() => convertIcostCaptureShortcut({ inputPath, outputPath }), /必须恰好包含/u);
    await assert.rejects(() => convertIcostCaptureShortcut({
      inputPath,
      outputPath,
      endpoint: "https://evil.example/capture",
    }), /canonical production/u);
  });

  it("rejects a legacy iCost action whose OCR value is not wrapped as text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shortcut-icost-converter-rich-value-"));
    temporaryDirectories.push(directory);
    const inputPath = join(directory, "source.shortcut");
    const outputPath = join(directory, "converted.shortcut");
    const plist = sourcePlist();
    plist.WFWorkflowActions[3].WFWorkflowActionParameters.rawText = {
      Value: { OutputUUID: "source-ocr", OutputName: "图像中的文本", Type: "ActionOutput" },
      WFSerializationType: "WFTextTokenAttachment",
    };
    await writeFile(inputPath, serializePlistXml(plist), { mode: 0o600 });
    await assert.rejects(() => convertIcostCaptureShortcut({ inputPath, outputPath }), /不是文本字符串/u);
  });

  it("rejects broken V7 control-flow grouping or preview-response variables", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shortcut-icost-converter-flow-"));
    temporaryDirectories.push(directory);
    const inputPath = join(directory, "source.shortcut");
    const outputPath = join(directory, "converted.shortcut");
    await writeFile(inputPath, serializePlistXml(sourcePlist()), { mode: 0o600 });
    await convertIcostCaptureShortcut({ inputPath, outputPath });
    const converted = parsePlistXml(await readFile(outputPath, "utf8"));

    const wrongVariable = structuredClone(converted);
    wrongVariable.WFWorkflowActions.find(
      (entry) => entry.WFWorkflowActionParameters?.CustomOutputName === "最终预览响应",
    ).WFWorkflowActionParameters.WFVariableName = "wrong_preview_response";
    assert.throws(
      () => inspectConvertedIcostCaptureShortcutXml(serializePlistXml(wrongVariable)),
      /预览响应变量必须一致/u,
    );

    const brokenGrouping = structuredClone(converted);
    const lastConditional = brokenGrouping.WFWorkflowActions.findLast(
      (entry) => entry.WFWorkflowActionIdentifier === "is.workflow.actions.conditional",
    );
    lastConditional.WFWorkflowActionParameters.GroupingIdentifier = "broken-group";
    assert.throws(
      () => inspectConvertedIcostCaptureShortcutXml(serializePlistXml(brokenGrouping)),
      /嵌套或分组标识不匹配/u,
    );
  });
});
