import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createAssistantAgentRunRepository } from "../src/assistant/agentRunRepository.js";
import { createPaymentProofAssistantAdapter } from "../src/assistant/paymentProofAssistantAdapter.js";

const sha256 = "a".repeat(64);

describe("payment-proof assistant adapter", () => {
  it("persists a redacted payment-proof-v1 preview without OCR text or unvalidated candidate IDs", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const runs = createAssistantAgentRunRepository(db, { idFactory: () => "payment-proof-run-1" });
    const adapter = createPaymentProofAssistantAdapter({ runRepository: runs });
    const result = await adapter.analyze({
      owner: "owner-1",
      channel: "desktop",
      conversationId: "c",
      eventId: "e",
      taskType: "ingest",
      document: { mediaType: "image/png", sizeBytes: 1024, sha256 },
      recognition: {
        extractedText: "敏感 OCR 全文不得进入运行记录",
        evidence: { amountCents: 8800, occurredOn: "2026-08-20", paidTime: "09:30", merchant: "示例商户", paymentMethod: "wechat" },
        confidence: 0.9,
        conflicts: [{ field: "amountCents", typedValue: 1, recognizedValue: 8800 }],
        warnings: ["EVIDENCE_CONFLICT"],
        candidates: [{ expenseId: "expense-secret", paymentId: "payment-secret" }],
        source: { provider: "deepseek", model: "secret-model" },
      },
    });
    assert.equal(result.schemaVersion, "payment-proof-v1");
    assert.equal(result.status, "review_required");
    assert.equal(result.recognition.evidence.amountCents, 8800);
    assert.equal(result.recognition.extractedTextPersisted, false);
    assert.equal(result.candidateMatch.candidateCount, 1);
    assert.deepEqual(result.candidateMatch.candidates, []);
    assert.deepEqual(result.sourceRefs, [{ type: "payment_proof_document", id: sha256 }]);
    assert.equal(result.writebackAllowed, false);
    const stored = runs.get(result.runId, { owner: "owner-1" }).item;
    assert.equal(stored.contractVersion, "payment-proof-v1");
    assert.equal(JSON.stringify(stored).includes("敏感 OCR"), false);
    assert.equal(JSON.stringify(stored).includes("expense-secret"), false);
    assert.equal(JSON.stringify(stored).includes("secret-model"), false);
    assert.equal(stored.input.owner, undefined);
    db.close();
  });

  it("replays by redacted document identity without accepting a changed recognition payload", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const runs = createAssistantAgentRunRepository(db, { idFactory: () => "payment-proof-run-replay" });
    const adapter = createPaymentProofAssistantAdapter({ runRepository: runs });
    const input = { owner: "owner-1", channel: "desktop", conversationId: "replay", eventId: "replay", taskType: "ingest", document: { mediaType: "image/png", sizeBytes: 1024, sha256 } };
    const first = await adapter.analyze({ ...input, recognition: { evidence: { amountCents: 8800 } } });
    const replay = await adapter.analyze({ ...input, recognition: { extractedText: "changed secret", evidence: { amountCents: 9999 } } });
    assert.equal(replay.replayed, true);
    assert.equal(replay.runId, first.runId);
    assert.equal(replay.recognition.evidence.amountCents, 8800);
    assert.equal(JSON.stringify(replay).includes("changed secret"), false);
    db.close();
  });
});
