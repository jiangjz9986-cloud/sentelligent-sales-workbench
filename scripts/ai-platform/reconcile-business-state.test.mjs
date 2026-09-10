import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../../backend/src/db.js";
import { createSecureSettingsRepository, DEEPSEEK_SETTING_KEY } from "../../backend/src/settings/repository.js";
import { reconcileCredentialChanges } from "./reconcile-business-state.mjs";

test("rollback reconciliation preserves a cleared provider and never revives a legacy fallback", () => {
  const db = openDatabase({ databaseUrl: ":memory:" });
  const encryptionKey = Buffer.alloc(32, 106).toString("base64url");
  const repository = createSecureSettingsRepository(db, { masterKey: encryptionKey });
  try {
    repository.setSecret(DEEPSEEK_SETTING_KEY, "synthetic-old-credential");
    const result = reconcileCredentialChanges(db, {
      encryptionKey, transitionId: "rollback-test",
      changes: [{ setting: DEEPSEEK_SETTING_KEY, status: "cleared", revision: 3 }],
    });
    assert.equal(result.updated, 1);
    assert.equal(repository.resolveSecret(DEEPSEEK_SETTING_KEY, "synthetic-environment-fallback"), "");
    assert.equal(repository.metadata(DEEPSEEK_SETTING_KEY).status, "cleared");
    const audit = db.prepare("SELECT after_json,metadata_json FROM audit_logs WHERE action='settings.platform_credential.reconcile'").get();
    assert.equal(JSON.parse(audit.after_json).status, "cleared");
    assert.equal(JSON.parse(audit.metadata_json).platformRevision, 3);
    assert.equal(JSON.stringify(audit).includes("synthetic"), false);
  } finally { db.close(); }
});
test("rollback reconciliation rejects an unrelated credential before any write", () => {
  const db = openDatabase({ databaseUrl: ":memory:" });
  try {
    assert.throws(() => reconcileCredentialChanges(db, {
      encryptionKey: Buffer.alloc(32, 107).toString("base64url"), transitionId: "rollback-test",
      changes: [{ setting: "unrelated", status: "cleared", revision: 1 }],
    }));
    assert.equal(db.prepare("SELECT count(*) n FROM secure_settings").get().n, 0);
  } finally { db.close(); }
});
