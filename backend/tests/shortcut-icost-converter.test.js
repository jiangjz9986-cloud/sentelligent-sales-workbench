import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { serializePlistXml } from "../../integrations/icost-shortcut/plist-xml.mjs";
import {
  CAPTURE_ACCOUNT_PLACEHOLDER,
  CAPTURE_INLINE_ENDPOINT,
  CAPTURE_PASSWORD_PLACEHOLDER,
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
      { WFWorkflowActionIdentifier: "com.gostraight.smallAccountBook.ICAISnapshotShortcutV7", WFWorkflowActionParameters: { UUID: "source-icost" } },
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
      actionCount: 12,
      endpoint: CAPTURE_INLINE_ENDPOINT,
      preservesCapturePrefix: true,
      removesIcostWrite: true,
      hasInlineCredentials: true,
      hasFailureNotice: true,
      hasSuccessReceipt: false,
      payloadKeys: ["account", "password", "text", "idempotency_key", "source_id", "source"],
    });
    const xml = await readFile(outputPath, "utf8");
    assert.match(xml, new RegExp(CAPTURE_ACCOUNT_PLACEHOLDER, "u"));
    assert.match(xml, new RegExp(CAPTURE_PASSWORD_PLACEHOLDER, "u"));
    assert.doesNotMatch(xml, /ICAISnapshotShortcutV7/u);
    assert.deepEqual(inspectConvertedIcostCaptureShortcutXml(xml), report);
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
});
