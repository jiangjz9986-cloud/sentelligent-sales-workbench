import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAssistantPendingActionRepository } from "../src/assistant/pendingActionRepository.js";
import { createAssistantSessionRepository } from "../src/assistant/sessionRepository.js";
import { createShortcutBookkeepingAssistantRuntime } from "../src/assistant/shortcutBookkeepingRuntime.js";
import { openDatabase } from "../src/db.js";
import { createShortcutBookkeepingRepository } from "../src/integrations/shortcutBookkeepingRepository.js";
import { createTravelExpenseDocumentInboxRepository } from "../src/travelExpense/documentInboxRepository.js";
import { createTravelExpenseRepository } from "../src/travelExpense/repository.js";
import { createWeixinConfirmationOutboxRepository } from "../src/weixin/outboxRepository.js";
import { VALID_JPEG, VALID_PNG } from "./helpers/image-fixtures.js";

function harness(t) {
  const directory = mkdtempSync(join(tmpdir(), "bookkeeping-lifecycle-"));
  const databaseUrl = join(directory, "fixture.sqlite");
  let db;
  let sequence = 0;
  let currentTime = "2026-10-01T01:00:00.000Z";
  const clock = () => new Date(currentTime);
  const idFactory = () => `fixture-${++sequence}`;
  const confirmationSecret = Buffer.alloc(32, 65);
  const h = { setTime: (value) => { currentTime = value; } };
  function restart() {
    db?.close();
    db = openDatabase({ databaseUrl });
    const entries = createShortcutBookkeepingRepository(db, { clock, idFactory });
    const expenses = createTravelExpenseRepository(db, { clock, idFactory });
    const inbox = createTravelExpenseDocumentInboxRepository(db, { clock, idFactory });
    const outbox = { ...createWeixinConfirmationOutboxRepository(db, { clock, idFactory }) };
    const runtime = createShortcutBookkeepingAssistantRuntime({
      db, clock, idFactory, batchIdFactory: idFactory, batchWindowMs: 0,
      config: { weixinBookkeepingConfirmationEnabled: true },
      shortcutBookkeepingRepository: entries,
      travelExpenseRepository: expenses,
      travelExpenseDocumentInboxRepository: inbox,
      pendingActionRepository: createAssistantPendingActionRepository(db, { clock, idFactory, confirmationSecret }),
      sessionRepository: createAssistantSessionRepository(db, { clock, idFactory }),
      outboxRepository: outbox,
      bindingsRepository: {
        hasActive: () => true,
        activeByAccount: (account) => ({ account, senderId: `sender-${account}`, status: "active" }),
      },
      confirmationSecret,
    });
    Object.assign(h, { db, entries, expenses, inbox, outbox, runtime });
  }
  h.restart = restart;
  restart();
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  h.capture = ({ owner = "owner-a", sourceId = idFactory(), amountCents = 1234, review = false } = {}) => {
    const received = h.entries.receive({
      owner, actor: owner, ledgerName: "出差报销", entryType: "expense",
      category: "交通", idempotencyKey: idFactory(), requestHash: "a".repeat(64),
      sourceId, rawText: "合成付款", capturedAt: currentTime,
    });
    const claimed = h.entries.claim(received.item.id);
    return h.entries.completeLocal(received.item.id, {
      leaseToken: claimed.leaseToken,
      analysis: {
        status: review ? "review_required" : "ready", confidence: 1, category: "交通",
        expense: {
          occurredOn: "2026-10-01", paidAt: "2026-10-01T09:00:00+08:00",
          amountCents, reimbursementCents: amountCents, purpose: "合成交通",
          fundingSource: "personal", paymentMethod: "wechat",
        }, warnings: [], source: { provider: "test" },
      },
    }).item;
  };
  h.proof = (entry) => h.inbox.createDocument({
    owner: entry.owner, actor: entry.owner, source: "weixin", sourceRef: entry.sourceId,
    documentKind: "payment_proof", fileName: "proof.png", mediaType: "image/png",
    content: VALID_PNG, status: "review_required", recognition: { fixture: true },
  });
  h.accept = (entry) => {
    const claimed = h.entries.claimReview(entry.id, { owner: entry.owner, actor: entry.owner });
    const accepted = h.entries.completeLocal(entry.id, {
      leaseToken: claimed.leaseToken, analysis: { ...entry.analysis, status: "ready" },
    }).item;
    h.runtime.settleFromWeb({ account: entry.owner, entry: accepted });
    return accepted;
  };
  h.summaryRows = () => h.db.prepare(`
    SELECT * FROM weixin_confirmation_outbox WHERE json_extract(payload_json, '$.kind') = 'accepted_batch'
  `).all();
  h.summary = (row = h.summaryRows()[0]) => ({ owner: row.owner, payload: JSON.parse(row.payload_json) });
  h.twoDrafts = (owner = "owner-a") => {
    const first = h.capture({ owner, review: true, amountCents: 1234 });
    const second = h.capture({ owner, review: true, amountCents: 9876 });
    h.runtime.startReview({ account: owner, entry: first });
    h.runtime.startReview({ account: owner, entry: second });
    return [first, second];
  };
  return h;
}

function attachedFixture(h, owner = "owner-a", sourceId = undefined) {
  const entry = h.capture({ owner, sourceId });
  const proof = h.proof(entry);
  h.runtime.reconcileAcceptedAttachments();
  const expense = h.expenses.getExpense(entry.expenseId, { owner });
  assert.equal(expense.attachments.length, 1);
  return { entry, proof, expense, attachment: expense.attachments[0] };
}

test("F2 deleting a WeChat proof atomically detaches it and never resurrects it after restart", (t) => {
  const h = harness(t);
  const { entry, proof, expense, attachment } = attachedFixture(h);
  h.expenses.deleteAttachment(attachment.id, { owner: entry.owner, actor: entry.owner, expectedVersion: expense.version });
  assert.equal(h.inbox.getDocument(proof.id, { owner: entry.owner }).recognition.attachmentId, undefined);
  assert.equal(h.db.prepare("SELECT reason FROM bookkeeping_proof_detachments").get()?.reason, "deleted");
  h.restart();
  for (let i = 0; i < 3; i += 1) h.runtime.reconcileAcceptedAttachments();
  assert.equal(h.expenses.getExpense(entry.expenseId, { owner: entry.owner }).attachments.length, 0);
  assert.equal(h.entries.getReview(entry.id, { owner: entry.owner }).status, "accepted");
});

test("F2 stale inbox IDs are repaired after an interrupted attachment write, including a stale ID with a live proof", (t) => {
  const h = harness(t);
  const { entry, proof, attachment } = attachedFixture(h);
  h.db.prepare("DELETE FROM travel_expense_attachments WHERE id = ?").run(attachment.id);
  h.restart();
  h.runtime.reconcileAcceptedAttachments();
  let expense = h.expenses.getExpense(entry.expenseId, { owner: entry.owner });
  assert.equal(expense.attachments.length, 1);
  assert.notEqual(expense.attachments[0].id, attachment.id);
  assert.equal(h.inbox.getDocument(proof.id, { owner: entry.owner }).recognition.attachmentId, expense.attachments[0].id);
  h.db.prepare("UPDATE travel_expense_document_inbox SET recognition_json = json_set(recognition_json, '$.attachmentId', 'missing') WHERE id = ?").run(proof.id);
  h.runtime.reconcileAcceptedAttachments();
  expense = h.expenses.getExpense(entry.expenseId, { owner: entry.owner });
  assert.equal(h.inbox.getDocument(proof.id, { owner: entry.owner }).recognition.attachmentId, expense.attachments[0].id);
  assert.equal(expense.attachments.length, 1);
});

test("F2 manual replacement and delete-then-upload keep the user's proof through repeated compensation", (t) => {
  const h = harness(t);
  const { entry, proof, expense, attachment } = attachedFixture(h);
  const replaced = h.expenses.replaceAttachment(attachment.id, {
    owner: entry.owner, actor: entry.owner, expectedVersion: expense.version,
    fileName: "manual.jpg", mediaType: "image/jpeg", content: VALID_JPEG,
  });
  assert.equal(h.db.prepare("SELECT reason FROM bookkeeping_proof_detachments").get()?.reason, "replaced");
  h.restart();
  h.runtime.reconcileAcceptedAttachments();
  assert.deepEqual(h.expenses.getAttachmentContent(attachment.id, { owner: entry.owner }).content, VALID_JPEG);
  assert.equal(h.inbox.getDocument(proof.id, { owner: entry.owner }).recognition.attachmentId, undefined);
  const deleted = h.expenses.deleteAttachment(attachment.id, { owner: entry.owner, actor: entry.owner, expectedVersion: replaced.version });
  h.expenses.addAttachment(entry.expenseId, {
    owner: entry.owner, actor: entry.owner, expectedVersion: deleted.version,
    paymentIds: [entry.paymentId], kind: "payment_proof", fileName: "manual.jpg",
    mediaType: "image/jpeg", content: VALID_JPEG,
  });
  h.runtime.reconcileAcceptedAttachments();
  assert.equal(h.expenses.getExpense(entry.expenseId, { owner: entry.owner }).attachments.length, 1);
});

test("F2 detachment, inbox cleanup and deletion roll back together; owner/version failures leave no marker", (t) => {
  const h = harness(t);
  const { entry, proof, expense, attachment } = attachedFixture(h);
  assert.throws(() => h.expenses.deleteAttachment(attachment.id, { owner: "owner-b", actor: "owner-b", expectedVersion: expense.version }));
  assert.throws(() => h.expenses.deleteAttachment(attachment.id, { owner: entry.owner, actor: entry.owner, expectedVersion: expense.version + 1 }));
  h.db.exec("CREATE TRIGGER fail_fixture_delete BEFORE DELETE ON travel_expense_attachments BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END");
  assert.throws(() => h.expenses.deleteAttachment(attachment.id, { owner: entry.owner, actor: entry.owner, expectedVersion: expense.version }), /fixture rollback/);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM bookkeeping_proof_detachments").get().n, 0);
  assert.equal(h.expenses.getExpense(entry.expenseId, { owner: entry.owner }).version, expense.version);
  assert.equal(h.inbox.getDocument(proof.id, { owner: entry.owner }).recognition.attachmentId, attachment.id);
});

test("F2 detachment is isolated between owners with the same source message", (t) => {
  const h = harness(t);
  const first = attachedFixture(h, "owner-a", "shared-source-message");
  const second = attachedFixture(h, "owner-b", "shared-source-message");
  h.expenses.deleteAttachment(first.attachment.id, { owner: "owner-a", actor: "owner-a", expectedVersion: first.expense.version });
  h.db.prepare("DELETE FROM travel_expense_attachments WHERE id = ?").run(second.attachment.id);
  h.runtime.reconcileAcceptedAttachments();
  assert.equal(h.expenses.getExpense(first.entry.expenseId, { owner: "owner-a" }).attachments.length, 0);
  assert.equal(h.expenses.getExpense(second.entry.expenseId, { owner: "owner-b" }).attachments.length, 1);
  assert.deepEqual(h.db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(h.db.prepare("PRAGMA quick_check").get().quick_check, "ok");
});

test("F2 deleting one target in a shared inbox does not detach its other accepted payment", (t) => {
  const h = harness(t);
  const { entry, proof, expense, attachment } = attachedFixture(h, "owner-a", "multi-source");
  const other = h.capture({ sourceId: entry.sourceId, amountCents: 4567 });
  h.runtime.reconcileAcceptedAttachments();
  const otherAttachment = h.expenses.getExpense(other.expenseId, { owner: other.owner }).attachments[0];
  assert.ok(otherAttachment);
  h.expenses.deleteAttachment(attachment.id, { owner: entry.owner, actor: entry.owner, expectedVersion: expense.version });
  h.db.prepare("DELETE FROM travel_expense_attachments WHERE id = ?").run(otherAttachment.id);
  h.restart();
  h.runtime.reconcileAcceptedAttachments();
  assert.equal(h.expenses.getExpense(entry.expenseId, { owner: entry.owner }).attachments.length, 0);
  assert.equal(h.expenses.getExpense(other.expenseId, { owner: other.owner }).attachments.length, 1);
  const markers = h.db.prepare("SELECT inbox_id, expense_id, payment_id FROM bookkeeping_proof_detachments").all();
  assert.equal(markers.length, 1);
  assert.equal(markers[0].inbox_id, proof.id);
  assert.equal(markers[0].expense_id, entry.expenseId);
  assert.equal(markers[0].payment_id, entry.paymentId);
});

test("F2 repository guards stop stale in-flight compensation from adding or rematching detached proofs", (t) => {
  const h = harness(t);
  const { entry, proof, expense, attachment } = attachedFixture(h);
  const deleted = h.expenses.deleteAttachment(attachment.id, { owner: entry.owner, actor: entry.owner, expectedVersion: expense.version });
  assert.throws(() => h.expenses.addAttachment(entry.expenseId, {
    owner: entry.owner, actor: entry.owner, expectedVersion: deleted.version,
    paymentIds: [entry.paymentId], kind: "payment_proof", sourceInboxId: proof.id,
    fileName: "proof.png", mediaType: "image/png", content: VALID_PNG,
    notes: `微信图片记账:${proof.id}`,
  }), { code: "BOOKKEEPING_PROOF_DETACHED" });
  const manual = h.expenses.addAttachment(entry.expenseId, {
    owner: entry.owner, actor: entry.owner, expectedVersion: deleted.version,
    paymentIds: [entry.paymentId], kind: "payment_proof",
    fileName: "manual.jpg", mediaType: "image/jpeg", content: VALID_JPEG,
  });
  const currentInbox = h.inbox.getDocument(proof.id, { owner: entry.owner });
  assert.throws(() => h.inbox.markMatched(proof.id, {
    owner: entry.owner, actor: entry.owner, expectedVersion: currentInbox.version,
    matchedExpenseId: entry.expenseId, matchedPaymentId: entry.paymentId,
    attachmentId: manual.attachments[0].id,
  }));
  h.runtime.reconcileAcceptedAttachments();
  assert.equal(h.expenses.getExpense(entry.expenseId, { owner: entry.owner }).attachments.length, 1);
});

test("F2 compensation preserves a valid manually confirmed inbox proof without an automatic marker", (t) => {
  const h = harness(t);
  const entry = h.capture();
  const proof = h.proof(entry);
  const expense = h.expenses.getExpense(entry.expenseId, { owner: entry.owner });
  const manual = h.expenses.addAttachment(entry.expenseId, {
    owner: entry.owner, actor: entry.owner, expectedVersion: expense.version,
    paymentIds: [entry.paymentId], kind: "payment_proof", fileName: "proof.png", mediaType: "image/png",
    content: VALID_PNG, notes: "微信付款凭证人工确认",
  }).attachments[0];
  h.inbox.markMatched(proof.id, {
    owner: entry.owner, actor: entry.owner, expectedVersion: proof.version,
    matchedExpenseId: entry.expenseId, matchedPaymentId: entry.paymentId, attachmentId: manual.id,
  });
  h.restart();
  for (let i = 0; i < 3; i += 1) h.runtime.reconcileAcceptedAttachments();
  const after = h.expenses.getExpense(entry.expenseId, { owner: entry.owner });
  assert.equal(after.attachments.length, 1);
  assert.equal(h.inbox.getDocument(proof.id, { owner: entry.owner }).recognition.attachmentId, manual.id);
  h.expenses.deleteAttachment(manual.id, { owner: entry.owner, actor: entry.owner, expectedVersion: after.version });
  h.restart();
  h.runtime.reconcileAcceptedAttachments();
  assert.equal(h.expenses.getExpense(entry.expenseId, { owner: entry.owner }).attachments.length, 0);
  assert.equal(h.db.prepare("SELECT reason FROM bookkeeping_proof_detachments").get().reason, "deleted");
});

test("F4 executed plus expired yields one renderable accepted summary after restart and repeat recovery", (t) => {
  const h = harness(t);
  const [first, second] = h.twoDrafts();
  h.accept(first);
  assert.equal(h.summaryRows().length, 0);
  h.setTime("2026-11-02T01:00:00.000Z");
  h.restart();
  for (let i = 0; i < 3; i += 1) h.runtime.reconcileAcceptedReceipts();
  assert.equal(h.summaryRows().length, 1);
  assert.deepEqual(h.summary().payload.entryIds, [first.id]);
  const rendered = h.runtime.renderOutboxMessage(h.summary());
  assert.match(rendered, /共 1 笔/);
  assert.match(rendered, /12\.34/);
  assert.doesNotMatch(rendered, /98\.76/);
  assert.match(rendered, /过期.*1.*未入账/);
  assert.equal(h.entries.getReview(second.id, { owner: second.owner }).status, "review_required");
  assert.equal(h.db.prepare("SELECT status FROM weixin_bookkeeping_batches").get().status, "completed");
});

test("F4 renderer accepts expired terminals and rejects a forged expired entry as accepted", (t) => {
  const h = harness(t);
  const [first, second] = h.twoDrafts();
  h.accept(first);
  h.db.prepare("UPDATE assistant_pending_actions SET status = 'expired' WHERE json_extract(payload_json, '$.entryId') = ?").run(second.id);
  const batchId = h.db.prepare("SELECT id FROM weixin_bookkeeping_batches").get().id;
  const item = { owner: first.owner, payload: { kind: "accepted_batch", batchVersion: 1, batchId, entryIds: [first.id] } };
  assert.match(h.runtime.renderOutboxMessage(item), /共 1 笔/);
  assert.throws(() => h.runtime.renderOutboxMessage({ ...item, payload: { ...item.payload, entryIds: [first.id, second.id] } }), /accepted_batch_incomplete/);
  assert.throws(() => h.runtime.renderOutboxMessage({ ...item, owner: "owner-b" }), /accepted_batch_incomplete/);
});

test("F4 an unfinished later queue delays expired batch receipt, while another owner cannot delay it", (t) => {
  const h = harness(t);
  const [first] = h.twoDrafts();
  h.accept(first);
  h.setTime("2026-11-02T01:00:00.000Z");
  const later = h.capture({ review: true });
  h.runtime.startReview({ account: later.owner, entry: later });
  h.twoDrafts("owner-b");
  h.runtime.reconcileAcceptedReceipts();
  assert.equal(h.summaryRows().length, 0);
  h.accept(later);
  h.runtime.reconcileAcceptedReceipts();
  assert.equal(h.summaryRows().filter((row) => row.owner === "owner-a").length, 1);
});

test("F4 all expired and all cancelled batches produce no accepted summary", (t) => {
  const h = harness(t);
  h.twoDrafts();
  const cancelled = h.twoDrafts("owner-b");
  for (const entry of cancelled) {
    h.db.prepare("UPDATE shortcut_bookkeeping_entries SET status = 'rejected' WHERE id = ?").run(entry.id);
    h.runtime.settleFromWeb({ account: entry.owner, entry: h.entries.getReview(entry.id, { owner: entry.owner }) });
  }
  h.setTime("2026-11-02T01:00:00.000Z");
  h.restart();
  h.runtime.reconcileAcceptedReceipts();
  h.runtime.reconcileAcceptedReceipts();
  assert.equal(h.summaryRows().length, 0);
});

test("F4 accepted plus cancelled summarizes only the persisted successful payment once", (t) => {
  const h = harness(t);
  const [first, second] = h.twoDrafts();
  const accepted = h.accept(first);
  h.db.prepare("UPDATE travel_expense_payments SET amount_cents = 2345 WHERE id = ?").run(accepted.paymentId);
  h.db.prepare("UPDATE shortcut_bookkeeping_entries SET status = 'rejected' WHERE id = ?").run(second.id);
  h.runtime.settleFromWeb({ account: second.owner, entry: h.entries.getReview(second.id, { owner: second.owner }) });
  h.restart();
  h.runtime.reconcileAcceptedReceipts();
  h.runtime.reconcileAcceptedReceipts();
  assert.equal(h.summaryRows().length, 1);
  const text = h.runtime.renderOutboxMessage(h.summary());
  assert.match(text, /共 1 笔/);
  assert.match(text, /23\.45/);
  assert.doesNotMatch(text, /12\.34|98\.76/);
  assert.match(text, /取消.*1.*未入账/);
});

test("F4 recovery completes an interrupted accepted action inside a multi-item batch", (t) => {
  const h = harness(t);
  const [first, second] = h.twoDrafts();
  h.accept(first);
  h.db.prepare("UPDATE assistant_pending_actions SET status = 'processing' WHERE json_extract(payload_json, '$.entryId') = ?").run(first.id);
  h.db.prepare("UPDATE assistant_pending_actions SET status = 'expired' WHERE json_extract(payload_json, '$.entryId') = ?").run(second.id);
  h.restart();
  h.runtime.reconcileAcceptedReceipts();
  assert.equal(h.summaryRows().length, 1);
  assert.equal(h.db.prepare("SELECT status FROM assistant_pending_actions WHERE json_extract(payload_json, '$.entryId') = ?").get(first.id).status, "executed");
});

test("F4 accepted/cancelled/expired mixed terminals count one successful payment", (t) => {
  const h = harness(t);
  const [first, second] = h.twoDrafts();
  const third = h.capture({ review: true, amountCents: 7777 });
  h.runtime.startReview({ account: third.owner, entry: third });
  h.accept(first);
  h.db.prepare("UPDATE shortcut_bookkeeping_entries SET status = 'rejected' WHERE id = ?").run(second.id);
  h.runtime.settleFromWeb({ account: second.owner, entry: h.entries.getReview(second.id, { owner: second.owner }) });
  h.setTime("2026-11-02T01:00:00.000Z");
  h.restart();
  h.runtime.reconcileAcceptedReceipts();
  assert.equal(h.summaryRows().length, 1);
  const text = h.runtime.renderOutboxMessage(h.summary());
  assert.match(text, /共 1 笔/);
  assert.match(text, /12\.34/);
  assert.doesNotMatch(text, /98\.76|77\.77/);
  assert.match(text, /过期.*1.*未入账/);
  assert.match(text, /取消.*1.*未入账/);
});

test("F4 failed summary enqueue recovers after restart and a locally acknowledged receipt is not duplicated", (t) => {
  const h = harness(t);
  const [first] = h.twoDrafts();
  h.accept(first);
  h.setTime("2026-11-02T01:00:00.000Z");
  const enqueue = h.outbox.enqueue;
  h.outbox.enqueue = (input) => {
    if (input.payload.kind === "accepted_batch") throw new Error("fixture outbox interruption");
    return enqueue(input);
  };
  h.runtime.reconcileAcceptedReceipts();
  assert.equal(h.summaryRows().length, 0);
  h.restart();
  h.runtime.reconcileAcceptedReceipts();
  assert.equal(h.summaryRows().length, 1);
  h.db.exec(`
    UPDATE weixin_confirmation_outbox SET status = 'failed'
    WHERE json_extract(payload_json, '$.kind') <> 'accepted_batch'
  `);
  const lease = h.outbox.leaseNext({ workerId: "fixture-worker", renderMessage: h.runtime.renderOutboxMessage });
  assert.equal(lease.item.payload.kind, "accepted_batch");
  assert.match(lease.message, /共 1 笔/);
  h.outbox.ackSuccess(lease.item.id, { leaseToken: lease.leaseToken, providerMessageId: "fixture-local-ack" });
  h.restart();
  h.runtime.reconcileAcceptedReceipts();
  h.runtime.reconcileAcceptedReceipts();
  assert.equal(h.summaryRows().length, 1);
  assert.equal(h.summaryRows()[0].status, "sent");
  assert.equal(h.outbox.leaseNext({ workerId: "fixture-worker", renderMessage: h.runtime.renderOutboxMessage }), null);
});
