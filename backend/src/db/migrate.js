import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { apply as applyPhase1WriteIntegrity } from "./migrations/0002_phase1_write_integrity.mjs";
import { apply as applyQuickRecordRiskIdentity } from "./migrations/0003_quick_record_risk_identity.mjs";
import { apply as applyVisitItineraries } from "./migrations/0005_visit_itineraries.mjs";
import { apply as applySalesDecisionAnalyses } from "./migrations/0006_sales_decision_analyses.mjs";
import { apply as applyTravelExpenses } from "./migrations/0007_travel_expenses.mjs";
import { apply as applyExpenseIngestionInvoices } from "./migrations/0008_expense_ingestion_invoices.mjs";
import { apply as applyLosslessDocumentBlobs } from "./migrations/0009_lossless_document_blobs.mjs";
import { apply as applyIdempotencyClaimLeases } from "./migrations/0010_idempotency_claim_leases.mjs";
import { apply as applyAssistantRuntimePersistence } from "./migrations/0011_assistant_runtime_persistence.mjs";
import { apply as applyAssistantOwnerAndPlanDigest } from "./migrations/0012_assistant_owner_and_plan_digest.mjs";
import { apply as applyAssistantConfirmationClosure } from "./migrations/0013_assistant_confirmation_closure.mjs";
import { apply as applyHospitalTenderMonitor } from "./migrations/0014_hospital_tender_monitor.mjs";
import { apply as applySecureSettings } from "./migrations/0015_secure_settings.mjs";
import { apply as applyHospitalTenderScheduler } from "./migrations/0016_hospital_tender_scheduler.mjs";
import { apply as applyShortcutWebhookTokens } from "./migrations/0017_shortcut_webhook_tokens.mjs";
import { apply as applyShortcutBookkeepingEntries } from "./migrations/0018_shortcut_bookkeeping_entries.mjs";
import { apply as applyShortcutWeixinConfirmation } from "./migrations/0019_shortcut_weixin_confirmation.mjs";
import { apply as applyShortcutIncomeEntries } from "./migrations/0020_shortcut_income_entries.mjs";
import { apply as applySecureSettingsPushplus } from "./migrations/0021_secure_settings_pushplus.mjs";
import { apply as applyAssistantAgentRuns } from "./migrations/0022_assistant_agent_runs.mjs";
import { apply as applyAssistantBusinessContext } from "./migrations/0023_assistant_business_context.mjs";
import { apply as applyShortcutAdvanceAllocation } from "./migrations/0024_shortcut_advance_allocation.mjs";
import { apply as applyTravelExpenseRegionProfiles } from "./migrations/0025_travel_expense_region_profiles.mjs";
import { apply as applyHospitalTenderActiveWindow } from "./migrations/0026_hospital_tender_active_window.mjs";
import { apply as applyCustomerProfileAliases } from "./migrations/0027_customer_profile_aliases.mjs";
import { apply as applyActionItemReminders } from "./migrations/0028_action_item_reminders.mjs";
import { apply as applyOwnerVocabularyCleanup } from "./migrations/0029_owner_vocabulary_cleanup.mjs";
import { apply as applyUsersTable } from "./migrations/0030_users_table.mjs";
import { apply as applyOwnerIsolationTightening } from "./migrations/0031_owner_isolation_tightening.mjs";
import { apply as applyWeixinBindings } from "./migrations/0032_weixin_bindings.mjs";
import { apply as applySecureSettingsAsr } from "./migrations/0033_secure_settings_asr.mjs";
import { apply as applyQuickRecordConfirmationPreviews } from "./migrations/0034_quick_record_confirmation_previews.mjs";
import { apply as applyVisitTemperatureSuggestions } from "./migrations/0035_visit_temperature_suggestions.mjs";
import { apply as applyAiSuggestionReview } from "./migrations/0036_ai_suggestion_review.mjs";
import { apply as applyAiModelProvenance } from "./migrations/0037_ai_model_provenance.mjs";
import { apply as applyProactiveConfirmationPreviews } from "./migrations/0038_proactive_confirmation_previews.mjs";
import { apply as applyProactiveBackgroundRuntime } from "./migrations/0039_proactive_background_runtime.mjs";
import { apply as applyProactiveNotifications } from "./migrations/0040_proactive_notifications.mjs";
import { apply as applyProactiveModelBudgetCache } from "./migrations/0041_proactive_model_budget_cache.mjs";
import { apply as applyCustomerProactiveSubjects } from "./migrations/0042_customer_proactive_subjects.mjs";
import { apply as applyHospitalTenderCanonicalBridge } from "./migrations/0043_hospital_tender_canonical_bridge.mjs";
import { apply as applyActionRiskWritebackFields } from "./migrations/0044_action_risk_writeback_fields.mjs";
import { apply as applyCustomerImportBatches } from "./migrations/0045_customer_import_batches.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const migrations = [
  {
    version: "0001",
    path: resolve(here, "migrations", "0001_baseline.sql"),
    type: "sql",
  },
  {
    version: "0002",
    path: resolve(here, "migrations", "0002_phase1_write_integrity.mjs"),
    type: "module",
    apply: applyPhase1WriteIntegrity,
  },
  {
    version: "0003",
    path: resolve(here, "migrations", "0003_quick_record_risk_identity.mjs"),
    type: "module",
    apply: applyQuickRecordRiskIdentity,
  },
  {
    version: "0005",
    path: resolve(here, "migrations", "0005_visit_itineraries.mjs"),
    type: "module",
    apply: applyVisitItineraries,
  },
  {
    version: "0006",
    path: resolve(here, "migrations", "0006_sales_decision_analyses.mjs"),
    type: "module",
    apply: applySalesDecisionAnalyses,
  },
  {
    version: "0007",
    path: resolve(here, "migrations", "0007_travel_expenses.mjs"),
    type: "module",
    apply: applyTravelExpenses,
  },
  {
    version: "0008",
    path: resolve(here, "migrations", "0008_expense_ingestion_invoices.mjs"),
    type: "module",
    apply: applyExpenseIngestionInvoices,
  },
  {
    version: "0009",
    path: resolve(here, "migrations", "0009_lossless_document_blobs.mjs"),
    type: "module",
    apply: applyLosslessDocumentBlobs,
  },
  {
    version: "0010",
    path: resolve(here, "migrations", "0010_idempotency_claim_leases.mjs"),
    type: "module",
    apply: applyIdempotencyClaimLeases,
  },
  {
    version: "0011",
    path: resolve(here, "migrations", "0011_assistant_runtime_persistence.mjs"),
    type: "module",
    apply: applyAssistantRuntimePersistence,
  },
  {
    version: "0012",
    path: resolve(here, "migrations", "0012_assistant_owner_and_plan_digest.mjs"),
    type: "module",
    apply: applyAssistantOwnerAndPlanDigest,
  },
  {
    version: "0013",
    path: resolve(here, "migrations", "0013_assistant_confirmation_closure.mjs"),
    type: "module",
    apply: applyAssistantConfirmationClosure,
  },
  {
    version: "0014",
    path: resolve(here, "migrations", "0014_hospital_tender_monitor.mjs"),
    type: "module",
    apply: applyHospitalTenderMonitor,
  },
  {
    version: "0015",
    path: resolve(here, "migrations", "0015_secure_settings.mjs"),
    type: "module",
    apply: applySecureSettings,
  },
  {
    version: "0016",
    path: resolve(here, "migrations", "0016_hospital_tender_scheduler.mjs"),
    type: "module",
    apply: applyHospitalTenderScheduler,
  },
  {
    version: "0017",
    path: resolve(here, "migrations", "0017_shortcut_webhook_tokens.mjs"),
    type: "module",
    apply: applyShortcutWebhookTokens,
  },
  {
    version: "0018",
    path: resolve(here, "migrations", "0018_shortcut_bookkeeping_entries.mjs"),
    type: "module",
    apply: applyShortcutBookkeepingEntries,
  },
  {
    version: "0019",
    path: resolve(here, "migrations", "0019_shortcut_weixin_confirmation.mjs"),
    type: "module",
    apply: applyShortcutWeixinConfirmation,
  },
  {
    version: "0020",
    path: resolve(here, "migrations", "0020_shortcut_income_entries.mjs"),
    type: "module",
    apply: applyShortcutIncomeEntries,
  },
  {
    version: "0021",
    path: resolve(here, "migrations", "0021_secure_settings_pushplus.mjs"),
    type: "module",
    apply: applySecureSettingsPushplus,
  },
  {
    version: "0022",
    path: resolve(here, "migrations", "0022_assistant_agent_runs.mjs"),
    type: "module",
    apply: applyAssistantAgentRuns,
  },
  {
    version: "0023",
    path: resolve(here, "migrations", "0023_assistant_business_context.mjs"),
    type: "module",
    apply: applyAssistantBusinessContext,
  },
  {
    version: "0024",
    path: resolve(here, "migrations", "0024_shortcut_advance_allocation.mjs"),
    type: "module",
    apply: applyShortcutAdvanceAllocation,
  },
  {
    version: "0025",
    path: resolve(here, "migrations", "0025_travel_expense_region_profiles.mjs"),
    type: "module",
    apply: applyTravelExpenseRegionProfiles,
  },
  {
    version: "0026",
    path: resolve(here, "migrations", "0026_hospital_tender_active_window.mjs"),
    type: "module",
    apply: applyHospitalTenderActiveWindow,
  },
  {
    version: "0027",
    path: resolve(here, "migrations", "0027_customer_profile_aliases.mjs"),
    type: "module",
    apply: applyCustomerProfileAliases,
  },
  {
    version: "0028",
    path: resolve(here, "migrations", "0028_action_item_reminders.mjs"),
    type: "module",
    apply: applyActionItemReminders,
  },
  {
    version: "0029",
    path: resolve(here, "migrations", "0029_owner_vocabulary_cleanup.mjs"),
    type: "module",
    apply: applyOwnerVocabularyCleanup,
  },
  {
    version: "0030",
    path: resolve(here, "migrations", "0030_users_table.mjs"),
    type: "module",
    apply: applyUsersTable,
  },
  {
    version: "0031",
    path: resolve(here, "migrations", "0031_owner_isolation_tightening.mjs"),
    type: "module",
    apply: applyOwnerIsolationTightening,
  },
  {
    version: "0032",
    path: resolve(here, "migrations", "0032_weixin_bindings.mjs"),
    type: "module",
    apply: applyWeixinBindings,
  },
  {
    version: "0033",
    path: resolve(here, "migrations", "0033_secure_settings_asr.mjs"),
    type: "module",
    apply: applySecureSettingsAsr,
  },
  {
    version: "0034",
    path: resolve(here, "migrations", "0034_quick_record_confirmation_previews.mjs"),
    type: "module",
    apply: applyQuickRecordConfirmationPreviews,
  },
  {
    version: "0035",
    path: resolve(here, "migrations", "0035_visit_temperature_suggestions.mjs"),
    type: "module",
    apply: applyVisitTemperatureSuggestions,
  },
  {
    version: "0036",
    path: resolve(here, "migrations", "0036_ai_suggestion_review.mjs"),
    type: "module",
    apply: applyAiSuggestionReview,
  },
  {
    version: "0037",
    path: resolve(here, "migrations", "0037_ai_model_provenance.mjs"),
    type: "module",
    apply: applyAiModelProvenance,
  },
  {
    version: "0038",
    path: resolve(here, "migrations", "0038_proactive_confirmation_previews.mjs"),
    type: "module",
    apply: applyProactiveConfirmationPreviews,
  },
  {
    version: "0039",
    path: resolve(here, "migrations", "0039_proactive_background_runtime.mjs"),
    type: "module",
    apply: applyProactiveBackgroundRuntime,
  },
  {
    version: "0040",
    path: resolve(here, "migrations", "0040_proactive_notifications.mjs"),
    type: "module",
    apply: applyProactiveNotifications,
  },
  {
    version: "0041",
    path: resolve(here, "migrations", "0041_proactive_model_budget_cache.mjs"),
    type: "module",
    apply: applyProactiveModelBudgetCache,
  },
  {
    version: "0042",
    path: resolve(here, "migrations", "0042_customer_proactive_subjects.mjs"),
    type: "module",
    apply: applyCustomerProactiveSubjects,
  },
  {
    version: "0043",
    path: resolve(here, "migrations", "0043_hospital_tender_canonical_bridge.mjs"),
    type: "module",
    apply: applyHospitalTenderCanonicalBridge,
  },
  {
    version: "0044",
    path: resolve(here, "migrations", "0044_action_risk_writeback_fields.mjs"),
    type: "module",
    apply: applyActionRiskWritebackFields,
  },
  {
    version: "0045",
    path: resolve(here, "migrations", "0045_customer_import_batches.mjs"),
    type: "module",
    apply: applyCustomerImportBatches,
  },
];

const baselineRepairs = [
  { table: "action_items", column: "assignee", definition: "TEXT" },
  { table: "risk_items", column: "assignee", definition: "TEXT" },
  { table: "risk_items", column: "due", definition: "TEXT" },
  { table: "solution_drafts", column: "artifact_type", definition: "TEXT NOT NULL DEFAULT 'solution_framework'" }
];

const LEGACY_SETTINGS_VERSION = "0019";
const CANONICAL_SETTINGS_VERSION = "0021";

export function canonicalMigrationSource(source) {
  return source.replace(/\r\n/g, "\n");
}

export function migrationChecksum(source) {
  return createHash("sha256").update(canonicalMigrationSource(source)).digest("hex");
}

function hasPushplusSettingsSchema(db) {
  const columns = new Set(
    db.prepare("PRAGMA table_info(secure_settings)").all().map((column) => column.name),
  );
  const requiredColumns = [
    "setting_key",
    "ciphertext",
    "status",
    "created_at",
    "rotated_at",
    "updated_at",
    "last_success_at",
    "last_failure_at",
    "last_error_code",
    "last_delivery_count",
    "last_chunk_count",
  ];
  if (!requiredColumns.every((column) => columns.has(column))) return false;
  const table = db.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'secure_settings'
  `).get();
  return typeof table?.sql === "string"
    && table.sql.includes("hospital_tender_pushplus_token");
}

function reconcileLegacySettingsVersionCollision(db) {
  const legacy = db.prepare(
    "SELECT version, checksum FROM schema_migrations WHERE version = :version",
  ).get({ version: LEGACY_SETTINGS_VERSION });
  if (!legacy) return;

  const canonicalMigration = migrations.find(
    (migration) => migration.version === CANONICAL_SETTINGS_VERSION,
  );
  const canonicalChecksum = migrationChecksum(
    readFileSync(canonicalMigration.path, "utf8"),
  );
  // A Shortcut database also has version 0019. Only the exact checksum from
  // the former settings branch is eligible for this one-time ledger repair;
  // every unknown checksum remains subject to the normal fail-closed check.
  if (legacy.checksum !== canonicalChecksum) return;
  if (!hasPushplusSettingsSchema(db)) {
    throw new Error("Cannot reconcile legacy migration 0019 without the PushPlus settings schema");
  }

  const canonical = db.prepare(
    "SELECT version, checksum FROM schema_migrations WHERE version = :version",
  ).get({ version: CANONICAL_SETTINGS_VERSION });
  if (canonical && canonical.checksum !== canonicalChecksum) {
    throw new Error(`Checksum mismatch for migration ${CANONICAL_SETTINGS_VERSION}`);
  }
  if (canonical) {
    db.prepare("DELETE FROM schema_migrations WHERE version = :version")
      .run({ version: LEGACY_SETTINGS_VERSION });
  } else {
    db.prepare(`
      UPDATE schema_migrations SET version = :canonicalVersion
      WHERE version = :legacyVersion
    `).run({
      canonicalVersion: CANONICAL_SETTINGS_VERSION,
      legacyVersion: LEGACY_SETTINGS_VERSION,
    });
  }
}

function repairBaselineColumns(db) {
  for (const repair of baselineRepairs) {
    const columns = db.prepare(`PRAGMA table_info(${repair.table})`).all();
    if (!columns.some((column) => column.name === repair.column)) {
      db.exec(`ALTER TABLE ${repair.table} ADD COLUMN ${repair.column} ${repair.definition}`);
    }
  }
}

export function executeMigration(db, migration, source) {
  if (migration.type === "sql") {
    db.exec(source);
    return;
  }
  if (migration.type !== "module") {
    throw new Error(`Unknown migration type for ${migration.version}: ${migration.type}`);
  }
  if (typeof migration.apply !== "function") {
    throw new Error(`Module migration ${migration.version} must export a synchronous apply function`);
  }
  if (migration.apply.constructor?.name === "AsyncFunction") {
    throw new Error(`Module migration ${migration.version} apply function must be synchronous`);
  }

  const result = migration.apply(db);
  if (result && typeof result.then === "function") {
    throw new Error(`Module migration ${migration.version} returned a Promise; apply must be synchronous`);
  }
}

export function migrateDatabase(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);

    reconcileLegacySettingsVersionCollision(db);

    const findMigration = db.prepare(
      "SELECT checksum FROM schema_migrations WHERE version = :version"
    );
    const recordMigration = db.prepare(`
      INSERT INTO schema_migrations (version, checksum, applied_at)
      VALUES (:version, :checksum, CURRENT_TIMESTAMP)
    `);
    for (const migration of migrations) {
      const source = canonicalMigrationSource(readFileSync(migration.path, "utf8"));
      const checksum = migrationChecksum(source);
      const applied = findMigration.get({ version: migration.version });

      if (applied) {
        if (applied.checksum !== checksum) {
          throw new Error(`Checksum mismatch for migration ${migration.version}`);
        }
        continue;
      }

      executeMigration(db, migration, source);
      if (migration.version === "0001") repairBaselineColumns(db);
      recordMigration.run({ version: migration.version, checksum });
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
