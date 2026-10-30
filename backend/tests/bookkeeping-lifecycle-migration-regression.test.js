import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { apply } from "../src/db/migrations/0056_bookkeeping_proof_detachments.mjs";
import { createTravelExpenseDocumentInboxRepository } from "../src/travelExpense/documentInboxRepository.js";
import { createTravelExpenseRepository } from "../src/travelExpense/repository.js";
import { VALID_PNG } from "./helpers/image-fixtures.js";

test("0056 is additive, idempotent and keeps detachment history owner/target scoped", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE prior_history (id TEXT PRIMARY KEY); INSERT INTO prior_history VALUES ('kept')");
    apply(db);
    const insert = db.prepare(`
      INSERT INTO bookkeeping_proof_detachments
        (owner, inbox_id, expense_id, payment_id, attachment_id, reason, detached_by, detached_at)
      VALUES (?, 'inbox', 'expense', ?, 'attachment', 'deleted', 'actor', '2026-10-24T00:00:00.000Z')
    `);
    insert.run("owner-a", "payment");
    insert.run("owner-b", "payment");
    insert.run("owner-a", "payment-2");
    assert.throws(() => insert.run("owner-a", "payment"), /UNIQUE/);
    apply(db);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM bookkeeping_proof_detachments").get().n, 3);
    assert.equal(db.prepare("SELECT id FROM prior_history").get().id, "kept");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
  } finally {
    db.close();
  }
});

test("0056 upgrades a populated 0054 schema without rewriting business history", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    const directory = new URL("../src/db/migrations/", import.meta.url);
    const files = readdirSync(directory).filter((name) => /^\d{4}_.*\.(sql|mjs)$/u.test(name)
      && Number(name.slice(0, 4)) <= 54).sort();
    for (const file of files) {
      const url = new URL(file, directory);
      if (file.endsWith(".sql")) db.exec(readFileSync(url, "utf8"));
      else (await import(url.href)).apply(db);
    }
    let sequence = 0;
    const options = { idFactory: () => `history-${++sequence}`, clock: () => new Date("2026-10-24T00:00:00.000Z") };
    const expenses = createTravelExpenseRepository(db, options);
    const inbox = createTravelExpenseDocumentInboxRepository(db, options);
    const expense = expenses.createExpense({
      owner: "owner-a", actor: "owner-a", occurredOn: "2026-10-24", category: "transport", purpose: "合成历史交通",
      payments: [{ paidAt: "2026-10-24T08:00:00+08:00", amountCents: 1234, reimbursementCents: 1234, fundingSource: "personal" }],
    });
    const proof = inbox.createDocument({
      owner: "owner-a", actor: "owner-a", source: "weixin", sourceRef: "historical-source",
      documentKind: "payment_proof", fileName: "proof.png", mediaType: "image/png",
      content: VALID_PNG, status: "review_required",
    });
    const attached = expenses.addAttachment(expense.id, {
      owner: "owner-a", actor: "owner-a", expectedVersion: expense.version,
      kind: "payment_proof", paymentIds: [expense.payments[0].id],
      fileName: "proof.png", mediaType: "image/png", content: VALID_PNG,
      notes: `微信图片记账:${proof.id}`,
    });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
    const before = tables.map((table) => db.prepare(`SELECT * FROM "${table}"`).all());
    apply(db);
    apply(db);
    assert.deepEqual(tables.map((table) => db.prepare(`SELECT * FROM "${table}"`).all()), before);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM bookkeeping_proof_detachments").get().n, 0);
    expenses.deleteAttachment(attached.attachments[0].id, { owner: "owner-a", actor: "owner-a", expectedVersion: attached.version });
    assert.equal(db.prepare("SELECT payment_id FROM bookkeeping_proof_detachments").get().payment_id, expense.payments[0].id);
    assert.equal(expenses.getExpense(expense.id, { owner: "owner-a" }).payments[0].amountCents, 1234);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
  } finally {
    db.close();
  }
});
