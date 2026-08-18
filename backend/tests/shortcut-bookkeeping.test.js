import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  BOOKKEEPING_CATALOG,
  BOOKKEEPING_SELECTION_OPTIONS,
  buildBookkeepingShortcut,
  VERIFICATION_STATUS_OUTPUT_NAME,
} from "../../integrations/shortcut/build-bookkeeping-shortcut.mjs";
import { parsePlistXml, serializePlistXml } from "../../integrations/icost-shortcut/plist-xml.mjs";
import { inspectBookkeepingShortcutXml } from "../../integrations/shortcut/verify-bookkeeping-shortcut.mjs";
import {
  SHORTCUT_BOOKKEEPING_CATALOG,
  authenticateShortcutWebhook,
} from "../src/integrations/shortcutBookkeeping.js";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("自有截图记账快捷指令", () => {
  it("allows the legacy environment token only outside production", () => {
    const headers = { authorization: `Bearer ${"test-token"}` };
    const baseConfig = {
      shortcutWebhookToken: "test-token",
      shortcutWebhookOwner: "legacy-owner",
    };

    assert.equal(
      authenticateShortcutWebhook(headers, { ...baseConfig, nodeEnv: " Production " }),
      null,
    );
    assert.deepEqual(
      authenticateShortcutWebhook(headers, { ...baseConfig, nodeEnv: "test" }),
      {
        account: "legacy-owner",
        integration: "shortcut",
        kind: "integration",
        scheme: "bearer",
      },
    );
  });

  it("keeps the Shortcut catalog and backend validation catalog identical", () => {
    const backendLabels = Object.fromEntries(
      Object.entries(SHORTCUT_BOOKKEEPING_CATALOG).map(([ledger, config]) => [
        ledger,
        Object.fromEntries([
          ["收入", config.income],
          ["支出", config.expense],
        ]),
      ]),
    );
    assert.deepEqual(BOOKKEEPING_CATALOG, backendLabels);
    assert.deepEqual(Object.keys(BOOKKEEPING_CATALOG), ["出差报销"]);
  });

  it("builds a canonical compact OCR/category workflow with Token verification", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shortcut-bookkeeping-"));
    temporaryDirectories.push(directory);
    const outputPath = join(directory, "bookkeeping.unsigned.shortcut");
    const { report } = await buildBookkeepingShortcut({ outputPath });

    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
    assert.equal(report.actionCount, 21);
    assert.equal(report.menuCount, 0);
    assert.equal(report.selectionOptionCount, BOOKKEEPING_SELECTION_OPTIONS.length);
    assert.equal(report.selectionOptionCount, 12);
    assert.equal(report.hasCancellationGate, true);
    assert.equal(report.hasTokenVerification, true);
    assert.equal(report.canonicalMetadata, true);
    assert.equal(report.hasIcostAction, false);
    assert.deepEqual(report.ledgerOptions, ["出差报销"]);
    assert.deepEqual(report.payloadKeys, [
      "text", "selection_path", "note", "idempotency_key", "source",
    ]);
    const xml = await readFile(outputPath, "utf8");
    assert.doesNotMatch(xml, /com\.gostraight\.smallAccountBook\.ICAISnapshotShortcutV7/u);
    assert.doesNotMatch(xml, /BEGIN (?:OPENSSH |RSA )?PRIVATE KEY/u);
    assert.doesNotMatch(xml, /Bearer\s+[A-Za-z0-9_-]{12,}/u);
    assert.match(xml, /选择账本 · 收支 · 分类 · 子分类/u);
    assert.match(xml, /\/api\/integrations\/shortcut\/verify/u);
    assert.match(xml, /WFControlFlowMode/u);
    assert.match(xml, /is\.workflow\.actions\.choosefromlist/u);
    assert.doesNotMatch(xml, /is\.workflow\.actions\.choosefrommenu/u);
    assert.doesNotMatch(xml, /is\.workflow\.actions\.setvariable/u);
    assert.match(xml, /备注（可选，直接点完成跳过）/u);
    assert.match(xml, /已取消，不会上传任何记账数据/u);
    const plist = parsePlistXml(xml);
    assert.equal(
      plist.WFWorkflowActions[2].WFWorkflowActionParameters.CustomOutputName,
      VERIFICATION_STATUS_OUTPUT_NAME,
    );
    assert.equal(
      plist.WFWorkflowActions[3].WFWorkflowActionParameters.WFInput.Variable.Value.OutputName,
      VERIFICATION_STATUS_OUTPUT_NAME,
    );
  });

  it("keeps every business request inside the non-empty selection branch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shortcut-bookkeeping-"));
    temporaryDirectories.push(directory);
    const outputPath = join(directory, "bookkeeping.unsigned.shortcut");
    await buildBookkeepingShortcut({ outputPath });
    const plist = parsePlistXml(await readFile(outputPath, "utf8"));
    const actions = plist.WFWorkflowActions;
    const selection = actions.findIndex(
      (entry) => entry.WFWorkflowActionIdentifier === "is.workflow.actions.choosefromlist",
    );
    const cancellationGate = actions.findIndex(
      (entry, index) => index > selection
        && entry.WFWorkflowActionIdentifier === "is.workflow.actions.conditional"
        && entry.WFWorkflowActionParameters?.WFControlFlowMode === 0,
    );
    const businessRequest = actions.findIndex(
      (entry) => entry.WFWorkflowActionIdentifier === "is.workflow.actions.downloadurl"
        && new URL(entry.WFWorkflowActionParameters.WFURL).pathname
          === "/api/integrations/shortcut/bookkeeping",
    );
    const cancellationElse = actions.findIndex(
      (entry, index) => index > cancellationGate
        && entry.WFWorkflowActionIdentifier === "is.workflow.actions.conditional"
        && entry.WFWorkflowActionParameters?.WFControlFlowMode === 1,
    );
    assert.ok(selection < cancellationGate);
    assert.ok(cancellationGate < businessRequest);
    assert.ok(businessRequest < cancellationElse);
  });

  it("rejects an accidental iCost action or non-POST payload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shortcut-bookkeeping-"));
    temporaryDirectories.push(directory);
    const outputPath = join(directory, "bookkeeping.unsigned.shortcut");
    await buildBookkeepingShortcut({ outputPath });
    const xml = await readFile(outputPath, "utf8");
    assert.throws(
      () => inspectBookkeepingShortcutXml(xml.replace("is.workflow.actions.ask", "com.gostraight.smallAccountBook.ICAISnapshotShortcutV7")),
      /不得包含 iCost/u,
    );
    assert.throws(
      () => inspectBookkeepingShortcutXml(xml.replace("<string>POST</string>", "<string>GET</string>")),
      /必须使用 POST/u,
    );
  });

  it("rejects non-canonical control-flow UUIDs or missing Apple metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shortcut-bookkeeping-"));
    temporaryDirectories.push(directory);
    const outputPath = join(directory, "bookkeeping.unsigned.shortcut");
    await buildBookkeepingShortcut({ outputPath });
    const plist = parsePlistXml(await readFile(outputPath, "utf8"));
    const start = plist.WFWorkflowActions.find(
      (entry) => entry.WFWorkflowActionIdentifier === "is.workflow.actions.conditional"
        && entry.WFWorkflowActionParameters?.WFControlFlowMode === 0,
    );
    start.WFWorkflowActionParameters.UUID = "00000000-0000-4000-8000-00000000BEEF";
    assert.throws(
      () => inspectBookkeepingShortcutXml(serializePlistXml(plist)),
      /条件起点和否则分支不得写入 UUID/u,
    );

    delete start.WFWorkflowActionParameters.UUID;
    delete plist.WFWorkflowTypes;
    assert.throws(
      () => inspectBookkeepingShortcutXml(serializePlistXml(plist)),
      /工作流类型元数据/u,
    );
  });
});
