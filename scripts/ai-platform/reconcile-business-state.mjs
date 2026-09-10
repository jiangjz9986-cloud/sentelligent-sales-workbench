import { DatabaseSync } from "node:sqlite";
import { lstatSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BUSINESS_DATABASE } from "./production-contract.mjs";
import { previewUnavailableCustomerEvents, reconcileUnavailableCustomerEvents } from "../../backend/src/assistant/proactiveEventReconciliation.js";
import { createSecureSettingsRepository, DEEPSEEK_SETTING_KEY, ASR_SETTING_KEY } from "../../backend/src/settings/repository.js";
import { withImmediateTransaction } from "../../backend/src/db/transaction.js";
import { insertAudit } from "../../backend/src/audit/auditRepository.js";

export function reconcileCredentialChanges(db, { encryptionKey, changes, transitionId }) {
  if (!Array.isArray(changes) || changes.length > 2
    || typeof transitionId !== "string" || !/^[a-z0-9][a-z0-9-]{0,99}$/u.test(transitionId)
    || new Set(changes.map((item) => item.setting)).size !== changes.length) throw new Error("invalid credential reconciliation");
  for (const item of changes) {
    if (!item || Object.keys(item).some((key) => !["setting", "status", "value", "revision"].includes(key))
      || ![DEEPSEEK_SETTING_KEY, ASR_SETTING_KEY].includes(item.setting)
      || !["active", "cleared"].includes(item.status)
      || !Number.isSafeInteger(item.revision) || item.revision < 0
      || (item.status === "active" && (typeof item.value !== "string" || !item.value || item.value.length > 500))) throw new Error("invalid credential reconciliation");
  }
  const repository = createSecureSettingsRepository(db, { masterKey: encryptionKey });
  return withImmediateTransaction(db, () => {
    for (const item of changes) {
      if (item.status === "cleared") repository.clearSecret(item.setting);
      else repository.setSecret(item.setting, item.value);
      insertAudit(db, {
        action: "settings.platform_credential.reconcile", entityType: "secure_setting", entityId: item.setting,
        actor: "system:ai-platform-transition", requestId: transitionId,
        before: null, after: { status: item.status }, metadata: { platformRevision: item.revision },
      });
    }
    return { status: "passed", updated: changes.length };
  });
}

async function main() {
  const command = process.argv[2];
  if (!["events-preview", "events-apply", "credentials"].includes(command) || process.argv.length !== 3) throw new Error("invalid reconciliation command");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 16 * 1024) throw new Error("reconciliation input too large");
    chunks.push(chunk);
  }
  const input = bytes ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  const metadata = lstatSync(BUSINESS_DATABASE);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || realpathSync(BUSINESS_DATABASE) !== BUSINESS_DATABASE) throw new Error("database identity is unsafe");
  if (command !== "events-preview" && process.getuid?.() !== metadata.uid) throw new Error("business reconciliation must run as the database owner");
  const db = new DatabaseSync(BUSINESS_DATABASE, { readOnly: command === "events-preview" });
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  try {
    let result;
    if (command === "events-preview") result = previewUnavailableCustomerEvents(db);
    else if (command === "events-apply") result = reconcileUnavailableCustomerEvents(db, {
      expectedDigest: input.expectedDigest, actor: "system:ai-platform-transition", requestId: input.transitionId,
    });
    else result = reconcileCredentialChanges(db, input);
    process.stdout.write(JSON.stringify(result) + "\n");
  } finally { db.close(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(() => {
  process.stderr.write("STATE_RECONCILIATION_FAILED\n");
  process.exitCode = 1;
});
