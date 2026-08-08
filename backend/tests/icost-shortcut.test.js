import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";

import { buildShortcut } from "../../integrations/icost-shortcut/build-shortcut.mjs";
import {
  inspectShortcutXml,
  verifyShortcutFile,
} from "../../integrations/icost-shortcut/verify-shortcut.mjs";

const projectRoot = resolve(import.meta.dirname, "../..");
const integrationRoot = join(projectRoot, "integrations", "icost-shortcut");
const temporaryDirectories = [];

async function makeTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "sentelligent-icost-shortcut-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("single iCost ledger-routing Shortcut", () => {
  it("preserves the original iCost flow and routes only the two exact ledgers after iCost succeeds", async () => {
    const directory = await makeTemporaryDirectory();
    const outputPath = join(directory, "icost-ledger-routing.unsigned.shortcut");

    await buildShortcut({
      configPath: join(integrationRoot, "icost-dual-write.shortcut.example.json"),
      outputPath,
    });

    const report = await verifyShortcutFile(outputPath);
    assert.deepEqual(report.leadingActionIdentifiers, [
      "is.workflow.actions.takescreenshot",
      "is.workflow.actions.image.crop",
      "is.workflow.actions.extracttextfromimage",
    ]);
    assert.equal(
      report.icostActionIdentifier,
      "com.gostraight.smallAccountBook.ICAISnapshotShortcutV7",
    );
    assert.ok(report.icostActionIndex < report.sentelligentRequest.actionIndex);
    assert.ok(report.icostActionIndex < report.qingyangRequest.actionIndex);
    assert.deepEqual(report.ledgerOptions, [
      "出差报销",
      "biubiu",
      "仅记 iCost（不回传）",
    ]);
    assert.deepEqual(report.sentelligentRequest.conditionValues, ["出差报销"]);
    assert.deepEqual(report.qingyangRequest.conditionValues, ["biubiu"]);
    assert.deepEqual(report.unroutedLedgerValues, ["仅记 iCost（不回传）"]);
    assert.deepEqual(report.sentelligentRequest.payloadKeys.sort(), [
      "captured_at",
      "idempotency_key",
      "ledger_name",
      "source",
      "source_id",
      "text",
    ]);
    assert.deepEqual(report.qingyangRequest.payloadKeys.sort(), [
      "captured_at",
      "idempotency_key",
      "ledger_name",
      "source",
      "source_id",
      "text",
    ]);
    assert.equal(report.sentelligentRequest.source, "icost-shortcut");
    assert.equal(report.qingyangRequest.source, "icost-shortcut");
    assert.notEqual(report.sentelligentRequest.url, report.qingyangRequest.url);
    assert.deepEqual(report.importQuestionKinds, [
      "sentelligent_url",
      "sentelligent_token",
      "qingyang_url",
      "qingyang_token",
    ]);

    const xml = await readFile(outputPath, "utf8");
    assert.doesNotMatch(xml, /sk-[A-Za-z0-9_-]{16,}/u);
    assert.doesNotMatch(xml, /BEGIN (?:OPENSSH |RSA )?PRIVATE KEY/u);
    assert.doesNotMatch(xml, /Bearer\s+[A-Za-z0-9_-]{12,}/u);
  });

  it("rejects a tampered template that could cross-route an unknown ledger", async () => {
    const templatePath = join(integrationRoot, "icost-dual-write.template.plist");
    const xml = await readFile(templatePath, "utf8");
    const tampered = xml.replace("仅记 iCost（不回传）", "其他账本");
    assert.notEqual(tampered, xml);

    const directory = await makeTemporaryDirectory();
    const filePath = join(directory, "tampered.shortcut");
    await writeFile(filePath, tampered, "utf8");

    assert.throws(
      () => inspectShortcutXml(tampered),
      /unknown ledger fallback|未知账本/u,
    );
  });

  it("rejects duplicate action UUIDs before the Shortcut is signed", async () => {
    const templatePath = join(integrationRoot, "icost-dual-write.template.plist");
    const xml = await readFile(templatePath, "utf8");
    const uuidMatches = [...xml.matchAll(
      /<key>UUID<\/key>\s*<string>([0-9a-f-]{36})<\/string>/giu,
    )];
    assert.ok(uuidMatches.length > 2);
    const duplicate = uuidMatches[1][0].replace(uuidMatches[1][1], uuidMatches[0][1]);
    const tampered = xml.replace(uuidMatches[1][0], duplicate);
    assert.notEqual(tampered, xml);

    assert.throws(
      () => inspectShortcutXml(tampered),
      /duplicate action UUID/u,
    );
  });
});
