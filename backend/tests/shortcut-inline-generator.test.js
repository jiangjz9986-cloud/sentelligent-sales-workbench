import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  INLINE_ACCOUNT_PLACEHOLDER,
  INLINE_BOOKKEEPING_ENDPOINT,
  INLINE_FAILURE_MESSAGE,
  INLINE_PASSWORD_PLACEHOLDER,
  buildBookkeepingInlineShortcut,
} from "../../integrations/shortcut/build-bookkeeping-inline-shortcut.mjs";
import {
  BOOKKEEPING_CATEGORY_OPTIONS,
  BOOKKEEPING_ENTRY_TYPE_OPTIONS,
  BOOKKEEPING_SUBCATEGORY_OPTIONS,
} from "../../integrations/shortcut/build-bookkeeping-shortcut.mjs";
import { parsePlistXml, serializePlistXml } from "../../integrations/icost-shortcut/plist-xml.mjs";
import { inspectBookkeepingInlineShortcutXml } from "../../integrations/shortcut/verify-bookkeeping-inline-shortcut.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("手动账号密码版快捷指令生成器", () => {
  it("emits editable constants and no pairing/file/token actions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shortcut-inline-generator-"));
    temporaryDirectories.push(directory);
    const outputPath = join(directory, "inline.unsigned.shortcut");
    const { report } = await buildBookkeepingInlineShortcut({ outputPath });
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
    assert.equal(report.actionCount, 59);
    assert.equal(report.hasInlineCredentials, true);
    assert.equal(report.hasPairing, false);
    assert.equal(report.hasTokenVerification, false);
    const xml = await readFile(outputPath, "utf8");
    assert.match(xml, new RegExp(INLINE_ACCOUNT_PLACEHOLDER, "u"));
    assert.match(xml, new RegExp(INLINE_PASSWORD_PLACEHOLDER, "u"));
    assert.doesNotMatch(xml, /出差报销/u);
    assert.deepEqual(BOOKKEEPING_ENTRY_TYPE_OPTIONS, ["收入", "支出"]);
    for (const value of [
      ...BOOKKEEPING_CATEGORY_OPTIONS.收入,
      ...BOOKKEEPING_CATEGORY_OPTIONS.支出,
      ...BOOKKEEPING_SUBCATEGORY_OPTIONS.餐饮,
      ...BOOKKEEPING_SUBCATEGORY_OPTIONS.交通,
      ...BOOKKEEPING_SUBCATEGORY_OPTIONS.出差,
    ]) assert.match(xml, new RegExp(value, "u"));
    assert.doesNotMatch(xml, /documentpicker|凭据文件|REPLACE_ME|六位|确认码/u);
    assert.doesNotMatch(xml, /is\.workflow\.actions\.hash/u);
    assert.deepEqual(inspectBookkeepingInlineShortcutXml(xml).payloadKeys, [
      "account", "password", "text", "selection_path", "note", "idempotency_key", "source_id", "source",
    ]);
    const plist = parsePlistXml(xml);
    const showResults = plist.WFWorkflowActions.filter(
      (entry) => entry.WFWorkflowActionIdentifier === "is.workflow.actions.showresult",
    );
    assert.equal(showResults.length, 1);
    assert.equal(showResults[0].WFWorkflowActionParameters.Text.Value.string, INLINE_FAILURE_MESSAGE);
    const timeId = plist.WFWorkflowActions.find(
      (entry) => entry.WFWorkflowActionParameters?.CustomOutputName === "时间记账ID",
    );
    assert.equal(timeId.WFWorkflowActionParameters.WFDateFormat, "yyyyMMddHHmmss");
    assert.equal(report.menuDepth, 3);
    assert.equal(report.hasShortcutReceipt, false);
    assert.equal(report.hasFailureNotice, true);
    assert.equal(report.usesTimeId, true);

    const cancellation = plist.WFWorkflowActions.findIndex(
      (entry) => entry.WFWorkflowActionParameters?.CustomOutputName === "已取消三级分类",
    );
    const otherwise = plist.WFWorkflowActions.findIndex(
      (entry) => entry.WFWorkflowActionIdentifier === "is.workflow.actions.conditional"
        && entry.WFWorkflowActionParameters?.WFControlFlowMode === 1
        && entry.WFWorkflowActionParameters?.GroupingIdentifier
          === plist.WFWorkflowActions[cancellation - 1]?.WFWorkflowActionParameters?.GroupingIdentifier,
    );
    assert.equal(otherwise + 1, cancellation);
    const malformed = structuredClone(plist);
    [malformed.WFWorkflowActions[otherwise], malformed.WFWorkflowActions[cancellation]] = [
      malformed.WFWorkflowActions[cancellation],
      malformed.WFWorkflowActions[otherwise],
    ];
    assert.throws(
      () => inspectBookkeepingInlineShortcutXml(serializePlistXml(malformed)),
      /取消分支结构不正确/u,
    );

    for (const unsafeEndpoint of [
      "https://evil.example/api/integrations/shortcut/bookkeeping-inline",
      "https://user@82.156.210.199/api/integrations/shortcut/bookkeeping-inline",
      `${INLINE_BOOKKEEPING_ENDPOINT}?forward=1`,
      `${INLINE_BOOKKEEPING_ENDPOINT}#fragment`,
    ]) {
      assert.throws(
        () => inspectBookkeepingInlineShortcutXml(xml.replace(INLINE_BOOKKEEPING_ENDPOINT, unsafeEndpoint)),
        /接口地址不正确/u,
      );
    }
  });
});
