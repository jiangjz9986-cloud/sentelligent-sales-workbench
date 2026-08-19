import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createAssistantAgentRunRepository } from "../src/assistant/agentRunRepository.js";
import { createInvoiceAssistantAdapter } from "../src/assistant/invoiceAssistantAdapter.js";

const sha256 = "b".repeat(64);

describe("invoice assistant adapter", () => {
  it("persists a redacted invoice-v1 preview without OCR or model payloads", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const runs = createAssistantAgentRunRepository(db, { idFactory: () => "invoice-run-1" });
    const adapter = createInvoiceAssistantAdapter({ runRepository: runs });
    const result = await adapter.analyze({
      owner: "owner-1",
      channel: "desktop",
      conversationId: "c",
      eventId: "e",
      taskType: "ingest",
      document: { mediaType: "application/pdf", sizeBytes: 2048, sha256 },
      recognition: {
        status: "unmatched",
        extractedText: "敏感发票 OCR 全文",
        ocr: { raw: "secret-ocr" },
        model: { raw: "secret-model" },
        fields: { invoiceCode: "044002100111", invoiceNumber: "12345678", issuedOn: "2026-08-20", sellerName: "示例酒店", totalCents: 10000, suggestedCategory: "lodging" },
        conflicts: [{ field: "totalCents", ocrValue: 1, modelValue: 10000 }],
        warnings: ["SOURCE_CONFLICT"],
      },
    });
    assert.equal(result.schemaVersion, "invoice-v1");
    assert.equal(result.status, "review_required");
    assert.equal(result.recognition.fields.totalCents, 10000);
    assert.equal(result.recognition.extractedTextPersisted, false);
    assert.equal(result.recognition.modelPayloadPersisted, false);
    assert.equal(result.matchPreview.autoMatched, false);
    assert.deepEqual(result.sourceRefs, [{ type: "invoice_document", id: sha256 }]);
    assert.equal(result.writebackAllowed, false);
    const stored = runs.get(result.runId, { owner: "owner-1" }).item;
    assert.equal(stored.contractVersion, "invoice-v1");
    assert.equal(JSON.stringify(stored).includes("敏感发票 OCR"), false);
    assert.equal(JSON.stringify(stored).includes("secret-ocr"), false);
    assert.equal(JSON.stringify(stored).includes("secret-model"), false);
    assert.equal(stored.input.owner, undefined);
    db.close();
  });

  it("replays the same document without replacing the original redacted field snapshot", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const runs = createAssistantAgentRunRepository(db, { idFactory: () => "invoice-run-replay" });
    const adapter = createInvoiceAssistantAdapter({ runRepository: runs });
    const input = { owner: "owner-1", channel: "desktop", conversationId: "replay", eventId: "replay", taskType: "ingest", document: { mediaType: "application/pdf", sizeBytes: 2048, sha256 } };
    const first = await adapter.analyze({ ...input, recognition: { fields: { totalCents: 10000 } } });
    const replay = await adapter.analyze({ ...input, recognition: { extractedText: "changed secret", fields: { totalCents: 99999 } } });
    assert.equal(replay.replayed, true);
    assert.equal(replay.runId, first.runId);
    assert.equal(replay.recognition.fields.totalCents, 10000);
    assert.equal(JSON.stringify(replay).includes("changed secret"), false);
    db.close();
  });
});
