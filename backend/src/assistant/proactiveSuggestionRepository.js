import { createHash, randomUUID } from "node:crypto";

import { withImmediateTransaction } from "../db/transaction.js";
import { HttpError } from "../http/errors.js";

const MAX_CONTENT_BYTES = 512 * 1024;
const MAX_SOURCE_REFS = 100;
// `snoozed`, `dismissed`, and `expired` remain accepted for rows written by
// the first proactive runtime.  The global review surface uses the canonical
// eight-state vocabulary below; keeping both spellings at the repository
// boundary lets an upgrade preserve old rows without silently collapsing
// confirmed/executed/conflict into a different state.
const STATUS_VALUES = new Set([
  "pending", "deferred", "snoozed", "dismissed", "ignored", "resolved",
  "confirmed", "executed", "conflict", "expired", "failed",
]);
const TRIGGER_VALUES = new Set([
  "missing_next_step",
  "stale_opportunity",
  "stage_evidence_mismatch",
  "budget_unknown",
  "decision_chain_unknown",
  "action_due",
  "risk_open",
  "visit_follow_up",
  "tender_change",
  "purchase_timing_unknown",
  "custom",
]);
const SAFE_IDENTIFIER = /^[\u4e00-\u9fffA-Za-z0-9_.:-]{1,500}$/u;
const SENSITIVE_KEY = /(?:password|secret|token|authorization|cookie|credential|private.?key|raw.?content|body|contact|phone|mobile|email)/iu;
const VOLATILE_SUGGESTION_KEYS = new Set([
  "generatedAt",
  "modelAttempted",
  "modelCacheHit",
  "modelError",
  "modelLatencyMs",
]);

function text(value, name, max = 500) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) throw new TypeError(`${name} is invalid`);
  return normalized;
}

function optionalText(value, name, max = 500) {
  if (value === undefined || value === null || value === "") return null;
  return text(value, name, max);
}

function identifier(value, name, max = 500) {
  const normalized = text(value, name, max);
  if (!SAFE_IDENTIFIER.test(normalized)) throw new TypeError(`${name} is invalid`);
  return normalized;
}

function date(value, name, { nullable = false } = {}) {
  if ((value === undefined || value === null || value === "") && nullable) return null;
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${name} must be a valid date`);
  return parsed;
}

function iso(value, name, options = {}) {
  const parsed = date(value, name, options);
  return parsed ? parsed.toISOString() : null;
}

function clockDate(clock) {
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  return date(clock(), "clock");
}

function integer(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback } = {}) {
  const normalized = value === undefined || value === null ? fallback : value;
  if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) throw new TypeError(`${name} is invalid`);
  return normalized;
}

function hash(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function previewDigestFor(suggestion, target) {
  const preview = suggestion?.writebackPreview?.[target] ?? null;
  return hash(JSON.stringify(canonical({
    suggestionId: suggestion?.id ?? null,
    type: target,
    preview,
  })));
}

// JSON data is sorted before hashing so semantically identical model/rule
// snapshots do not create a new suggestion solely due to key order.
function canonical(value, path = "value", depth = 0, seen = new Set()) {
  if (depth > 12) throw new TypeError(`${path} is too deeply nested`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`);
    return value;
  }
  if (!value || typeof value !== "object") throw new TypeError(`${path} must be JSON data`);
  if (seen.has(value)) throw new TypeError(`${path} contains a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_SOURCE_REFS * 10) throw new TypeError(`${path} contains too many items`);
      return value.map((item, index) => canonical(item, `${path}[${index}]`, depth + 1, seen));
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError(`${path} must be a plain object`);
    }
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (SENSITIVE_KEY.test(key)) throw new TypeError(`${path}.${key} is sensitive`);
      result[key] = canonical(value[key], `${path}.${key}`, depth + 1, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function json(value, name, maxBytes = MAX_CONTENT_BYTES) {
  const encoded = JSON.stringify(canonical(value, name));
  if (!encoded || Buffer.byteLength(encoded, "utf8") > maxBytes) throw new TypeError(`${name} is too large`);
  return encoded;
}

// Scan timestamps and model delivery telemetry describe how a scan ran, not
// whether its business evidence changed. Keep them in the persisted content
// for diagnostics, but exclude them from the revision/dedupe hash so a later
// scan or a cache hit cannot create a new suggestion revision.
function stableSuggestionPayload(suggestion) {
  if (!suggestion || typeof suggestion !== "object" || Array.isArray(suggestion)) return {};
  const stable = { ...suggestion };
  for (const key of VOLATILE_SUGGESTION_KEYS) delete stable[key];
  if (stable.trigger && typeof stable.trigger === "object" && !Array.isArray(stable.trigger)) {
    stable.trigger = { ...stable.trigger };
    delete stable.trigger.detectedAt;
  }
  return stable;
}

function stableSuggestionPayloadHash(suggestion) {
  return hash(JSON.stringify(canonical(stableSuggestionPayload(suggestion), "suggestion")));
}

function parsed(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function rowToItem(row) {
  if (!row) return null;
  const suggestion = parsed(row.content, null);
  const suggestionObject = suggestion && typeof suggestion === "object" && !Array.isArray(suggestion)
    ? suggestion
    : {};
  return {
    // Keep the persisted suggestion payload additive.  The UI and preview
    // confirmation path need the same evidence/writeback fields that were
    // generated by the scanner, while the ledger columns below remain the
    // authoritative identity/lifecycle values.
    ...suggestionObject,
    id: row.id,
    version: Number(row.version ?? 1),
    owner: row.owner,
    // status is the proactive lifecycle state. aiStatus is retained so the
    // existing manual-ai review route can continue to interpret its column.
    status: row.proactive_status ?? "pending",
    lifecycleStatus: row.proactive_status ?? "pending",
    proactiveStatus: row.proactive_status ?? "pending",
    lifecycleVersion: Number(row.version ?? 1),
    aiStatus: row.status ?? null,
    type: row.type,
    title: row.title,
    content: row.content,
    draft: row.draft_content || row.content,
    confidence: Object.hasOwn(suggestionObject, "confidence")
      ? suggestionObject.confidence
      : (row.confidence === null || row.confidence === undefined ? null : Number(row.confidence)),
    sourceRefs: parsed(row.source_refs, []),
    confirmationPreview: parsed(row.confirmation_preview, {}),
    source: row.source ?? "legacy",
    fallbackReason: row.fallback_reason ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
    confirmedAt: row.confirmed_at ?? null,
    cancelledAt: row.cancelled_at ?? null,
    proactive: row.proactive_trigger !== null && row.proactive_trigger !== undefined,
    trigger: row.proactive_trigger ?? null,
    subjectType: row.proactive_subject_type ?? null,
    subjectId: row.proactive_subject_id ?? null,
    subjectKey: row.proactive_subject_key ?? suggestionObject.subjectKey ?? suggestionObject.customerSubjectKey ?? null,
    subjectVersion: row.proactive_subject_version === null || row.proactive_subject_version === undefined
      ? (suggestionObject.subjectVersion ?? suggestionObject.customerSubjectVersion ?? null)
      : Number(row.proactive_subject_version),
    sourceDigest: row.proactive_source_digest ?? suggestionObject.sourceDigest ?? suggestionObject.subjectSourceDigest ?? null,
    subjectSourceDigest: row.proactive_source_digest ?? suggestionObject.subjectSourceDigest ?? suggestionObject.sourceDigest ?? null,
    subjectSourceRefs: parsed(
      row.proactive_source_refs,
      suggestionObject.subjectSourceRefs ?? suggestionObject.sourceRefs ?? [],
    ),
    customerId: row.proactive_customer_id ?? null,
    opportunityId: row.proactive_opportunity_id ?? null,
    dedupeKey: row.proactive_dedupe_key ?? null,
    ruleVersion: row.proactive_rule_version ?? null,
    priority: Number(row.proactive_priority ?? 0),
    staleAt: row.proactive_stale_at ?? null,
    snoozedUntil: row.proactive_snoozed_until ?? null,
    dismissReason: row.proactive_dismiss_reason ?? null,
    resolvedAt: row.proactive_resolved_at ?? null,
    resultRefs: parsed(row.proactive_result_refs, []),
    runId: row.proactive_run_id ?? null,
    eventId: row.proactive_event_id ?? null,
    generatedAt: row.proactive_generated_at ?? null,
    lastSeenAt: row.proactive_last_seen_at ?? null,
    failureCount: Number(row.proactive_failure_count ?? 0),
    nextRetryAt: row.proactive_next_retry_at ?? null,
    payloadHash: row.proactive_payload_hash ?? null,
    suggestion,
  };
}

function lifecycleError(status) {
  return new HttpError(409, "PROACTIVE_SUGGESTION_STATE", `The proactive suggestion is ${status} and cannot be changed`);
}

const LIFECYCLE_TRANSITIONS = Object.freeze({
  pending: new Set(["pending", "deferred", "snoozed", "dismissed", "ignored", "resolved", "confirmed", "executed", "conflict", "failed"]),
  deferred: new Set(["pending", "deferred", "snoozed", "dismissed", "ignored", "resolved", "confirmed", "executed", "conflict", "failed"]),
  snoozed: new Set(["pending", "deferred", "snoozed", "dismissed", "ignored", "resolved", "confirmed", "executed", "conflict", "failed"]),
  dismissed: new Set(["pending", "resolved"]),
  ignored: new Set(["pending", "resolved"]),
  resolved: new Set(["pending", "resolved"]),
  confirmed: new Set(["confirmed", "executed", "resolved", "conflict", "failed"]),
  executed: new Set(["executed", "resolved"]),
  conflict: new Set(["pending", "confirmed", "executed", "conflict", "failed"]),
  expired: new Set(["pending"]),
  failed: new Set(["pending", "confirmed", "executed", "conflict", "failed"]),
});

function runMutation(db, work, { withinTransaction = false } = {}) {
  if (withinTransaction) return work();
  return withImmediateTransaction(db, work);
}

function normalizeEditableFields(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("fields must be an object");
  }
  const source = input.fields && typeof input.fields === "object" && !Array.isArray(input.fields)
    ? input.fields
    : input;
  const read = (...names) => {
    for (const name of names) {
      if (Object.hasOwn(source, name) && source[name] !== undefined) {
        return { provided: true, value: source[name] };
      }
    }
    return { provided: false, value: undefined };
  };
  const normalized = {};
  const owner = read("owner", "assignee");
  if (owner.provided) normalized.owner = owner.value === null ? null : text(owner.value, "assignee", 200);
  const dueDate = read("dueDate", "due");
  if (dueDate.provided) normalized.dueDate = dueDate.value === null ? null : text(dueDate.value, "dueDate", 80);
  const priority = read("priority");
  if (priority.provided) {
    normalized.priority = priority.value === null ? null : text(priority.value, "priority", 20);
    if (normalized.priority !== null && !new Set(["高", "中", "低", "high", "medium", "low"]).has(normalized.priority)) {
      throw new TypeError("priority is invalid");
    }
  }
  const expectedResult = read("expectedResult", "result");
  if (expectedResult.provided) {
    normalized.expectedResult = expectedResult.value === null
      ? null
      : text(expectedResult.value, "expectedResult", 500);
  }
  return normalized;
}

function mergeEditableFieldsIntoSuggestion(suggestion, fields) {
  const base = suggestion && typeof suggestion === "object" && !Array.isArray(suggestion)
    ? suggestion
    : {};
  const normalizePriority = (value) => ({ high: "高", medium: "中", low: "低" }[value] ?? value);
  const editable = base.reviewFields && typeof base.reviewFields === "object" && !Array.isArray(base.reviewFields)
    ? { ...base.reviewFields }
    : {};
  const previewPatch = {};
  if (Object.hasOwn(fields, "owner")) {
    editable.assignee = fields.owner;
    previewPatch.assignee = fields.owner;
  }
  if (Object.hasOwn(fields, "dueDate")) {
    editable.dueDate = fields.dueDate;
    previewPatch.dueDate = fields.dueDate;
  }
  if (Object.hasOwn(fields, "priority")) {
    editable.priority = normalizePriority(fields.priority);
    previewPatch.priority = editable.priority;
  }
  if (Object.hasOwn(fields, "expectedResult")) {
    editable.expectedResult = fields.expectedResult;
    previewPatch.expectedResult = fields.expectedResult;
  }
  const updatePreview = (preview) => {
    if (!preview || typeof preview !== "object" || Array.isArray(preview)) return preview;
    const next = { ...preview };
    const setExisting = (keys, value) => {
      for (const key of keys) {
        // Confirmation previews are server-owned and bounded by the HTTP
        // contract. Preserve their shape and only refresh an editable field
        // when that field was already part of the generated preview; the
        // complete human draft remains in reviewFields below.
        if (Object.hasOwn(preview, key)) next[key] = value;
      }
    };
    if (Object.hasOwn(previewPatch, "assignee")) {
      setExisting(["assignee", "assigneeName", "owner", "ownerName"], previewPatch.assignee);
    }
    if (Object.hasOwn(previewPatch, "dueDate")) {
      setExisting(["due", "dueDate", "followUpDate", "followUpAt"], previewPatch.dueDate);
    }
    if (Object.hasOwn(previewPatch, "priority")) setExisting(["priority"], previewPatch.priority);
    if (Object.hasOwn(previewPatch, "expectedResult")) {
      setExisting(["expectedResult", "expectedOutcome", "result"], previewPatch.expectedResult);
    }
    return next;
  };
  const currentWriteback = base.writebackPreview && typeof base.writebackPreview === "object"
    ? base.writebackPreview
    : {};
  return {
    ...base,
    reviewFields: editable,
    writebackPreview: {
      ...currentWriteback,
      ...(currentWriteback.action ? { action: updatePreview(currentWriteback.action) } : {}),
      ...(currentWriteback.risk ? { risk: updatePreview(currentWriteback.risk) } : {}),
    },
  };
}

/**
 * Durable repository for proactive suggestions.  It deliberately stores
 * proactive records in the existing ai_suggestions ledger, while all
 * proactive-only fields are namespaced by the migration's `proactive_*`
 * columns.  The partial unique index on (owner, proactive_dedupe_key) is the
 * database-level duplicate gate used by retries and concurrent workers.
 */
export function createProactiveSuggestionRepository(db, {
  clock = () => new Date(),
  idFactory = randomUUID,
} = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A synchronous SQLite connection is required");
  if (typeof idFactory !== "function") throw new TypeError("idFactory is required");

  const now = () => clockDate(clock).toISOString();
  const columns = tableColumns(db, "ai_suggestions");
  const hasCustomerSubjectColumns = [
    "proactive_subject_key",
    "proactive_subject_version",
    "proactive_source_digest",
    "proactive_source_refs",
  ].every((column) => columns.has(column));
  const selectById = (id, owner = null) => owner === null
    ? db.prepare("SELECT * FROM ai_suggestions WHERE id = $id").get({ $id: id })
    : db.prepare("SELECT * FROM ai_suggestions WHERE id = $id AND owner = $owner").get({ $id: id, $owner: owner });
  const selectByDedupe = (owner, dedupeKey) => db.prepare(`
    SELECT * FROM ai_suggestions
     WHERE owner = $owner AND proactive_dedupe_key = $dedupeKey
  `).get({ $owner: owner, $dedupeKey: dedupeKey });

  function normalize(input = {}) {
    const suggestion = input.suggestion ?? input.item;
    if (!suggestion || typeof suggestion !== "object" || Array.isArray(suggestion)) throw new TypeError("suggestion is required");
    const owner = identifier(input.owner, "owner", 200);
    const id = identifier(input.id ?? suggestion.id ?? idFactory(), "suggestion id");
    const trigger = text(input.trigger ?? suggestion.trigger?.type, "trigger", 100);
    if (!TRIGGER_VALUES.has(trigger) && !SAFE_IDENTIFIER.test(trigger)) throw new TypeError("trigger is invalid");
    const subjectType = text(input.subjectType ?? suggestion.subjectType ?? "opportunity", "subjectType", 100);
    const subjectId = identifier(input.subjectId ?? suggestion.subjectId ?? suggestion.opportunityId, "subjectId");
    const customerId = input.customerId ?? suggestion.customerId ?? null;
    const opportunityId = input.opportunityId ?? suggestion.opportunityId ?? null;
    const normalizedCustomerId = customerId === null || customerId === undefined || customerId === ""
      ? null : identifier(customerId, "customerId");
    const normalizedOpportunityId = opportunityId === null || opportunityId === undefined || opportunityId === ""
      ? null : identifier(opportunityId, "opportunityId");
    const dedupeKey = identifier(
      input.dedupeKey ?? `${trigger}:${subjectId}:${suggestion.id ?? id}`,
      "dedupeKey",
      500,
    );
    const status = text(input.status ?? "pending", "status", 20);
    if (!STATUS_VALUES.has(status)) throw new TypeError("status is invalid");
    const priority = integer(input.priority ?? suggestion.priority ?? 0, "priority", { min: 0, max: 100 });
    const rawConfidence = Object.hasOwn(input, "confidence") ? input.confidence : suggestion.confidence;
    const confidence = rawConfidence === null || rawConfidence === undefined || rawConfidence === ""
      ? null
      : Number(rawConfidence);
    if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 100)) {
      throw new TypeError("confidence is invalid");
    }
    const source = text(input.source ?? suggestion.source ?? "deterministic", "source", 100);
    const fallbackReason = optionalText(input.fallbackReason ?? suggestion.fallbackReason, "fallbackReason", 200);
    const sourceRefs = Array.isArray(input.sourceRefs) ? input.sourceRefs : (Array.isArray(suggestion.sourceRefs) ? suggestion.sourceRefs : []);
    if (sourceRefs.length > MAX_SOURCE_REFS) throw new TypeError("sourceRefs contains too many items");
    const sourceRefsJson = json(sourceRefs, "sourceRefs", 64 * 1024);
    const rawSubjectKey = input.subjectKey ?? suggestion.subjectKey ?? suggestion.customerSubjectKey ?? null;
    const subjectKey = rawSubjectKey === null || rawSubjectKey === undefined || rawSubjectKey === ""
      ? null
      : identifier(rawSubjectKey, "subjectKey", 500);
    const rawSubjectVersion = input.subjectVersion ?? suggestion.subjectVersion ?? suggestion.customerSubjectVersion ?? null;
    const subjectVersion = rawSubjectVersion === null || rawSubjectVersion === undefined || rawSubjectVersion === ""
      ? null
      : integer(rawSubjectVersion, "subjectVersion", { min: 1 });
    const rawSourceDigest = input.sourceDigest ?? suggestion.sourceDigest ?? suggestion.subjectSourceDigest ?? null;
    const sourceDigest = rawSourceDigest === null || rawSourceDigest === undefined || rawSourceDigest === ""
      ? null
      : text(rawSourceDigest, "sourceDigest", 64).toLowerCase();
    if (sourceDigest !== null && !/^[0-9a-f]{64}$/u.test(sourceDigest)) throw new TypeError("sourceDigest is invalid");
    const subjectSourceRefs = Array.isArray(input.subjectSourceRefs)
      ? input.subjectSourceRefs
      : Array.isArray(suggestion.subjectSourceRefs)
        ? suggestion.subjectSourceRefs
        : sourceRefs;
    if (subjectSourceRefs.length > MAX_SOURCE_REFS) throw new TypeError("subjectSourceRefs contains too many items");
    const subjectSourceRefsJson = json(subjectSourceRefs, "subjectSourceRefs", 64 * 1024);
    const hasSubjectMetadata = subjectKey !== null || subjectVersion !== null || sourceDigest !== null;
    if (hasSubjectMetadata && !hasCustomerSubjectColumns) {
      throw new TypeError("customer proactive subject columns are unavailable; apply migration 0042 first");
    }
    if (hasSubjectMetadata && (subjectKey === null || subjectVersion === null || sourceDigest === null)) {
      throw new TypeError("subjectKey, subjectVersion, and sourceDigest must be supplied together");
    }
    const resultRefsJson = json(input.resultRefs ?? [], "resultRefs", 64 * 1024);
    const contentJson = json(suggestion, "suggestion");
    const confirmationPreview = suggestion.writebackPreview ?? suggestion.confirmationPreview ?? {};
    const confirmationPreviewJson = json(confirmationPreview, "confirmationPreview", 64 * 1024);
    const generatedAt = iso(input.generatedAt ?? suggestion.generatedAt ?? suggestion.trigger?.detectedAt ?? clockDate(clock), "generatedAt");
    const staleAt = iso(input.staleAt, "staleAt", { nullable: true });
    const snoozedUntil = iso(input.snoozedUntil, "snoozedUntil", { nullable: true });
    return {
      suggestion,
      owner,
      id,
      title: text(input.title ?? suggestion.title, "title", 500),
      ruleVersion: optionalText(input.ruleVersion ?? suggestion.modelVersion ?? suggestion.schemaVersion, "ruleVersion", 200),
      trigger,
      subjectType,
      subjectId,
      customerId: normalizedCustomerId,
      opportunityId: normalizedOpportunityId,
      dedupeKey,
      status,
      priority,
      confidence,
      source,
      fallbackReason,
      sourceRefsJson,
      subjectKey,
      subjectVersion,
      sourceDigest,
      subjectSourceRefsJson,
      resultRefsJson,
      contentJson,
      confirmationPreviewJson,
      generatedAt,
      staleAt,
      snoozedUntil,
      runId: input.runId === undefined || input.runId === null ? null : identifier(input.runId, "runId"),
      eventId: input.eventId === undefined || input.eventId === null ? null : identifier(input.eventId, "eventId"),
      payloadHash: stableSuggestionPayloadHash(suggestion),
    };
  }

  function save(input = {}, { withinTransaction = false } = {}) {
    const value = normalize(input);
    const nowIso = now();
    return runMutation(db, () => {
      const existingByDedupe = selectByDedupe(value.owner, value.dedupeKey);
      if (existingByDedupe) {
        // The deterministic assistant keeps a stable identity while a row is
        // observed repeatedly. Its human-readable age/reason text can change
        // between scans (for example, day 21 -> day 22), so update the single
        // deduped row rather than turning an unchanged source into an error or
        // a second suggestion. Lifecycle state is intentionally preserved.
        let existingPayloadHash = existingByDedupe.proactive_payload_hash;
        let persistedSuggestion = null;
        try {
          persistedSuggestion = parsed(existingByDedupe.content, {});
          existingPayloadHash = stableSuggestionPayloadHash(persistedSuggestion);
        } catch {
          // Preserve the legacy hash when an old row cannot be normalized;
          // the normal write path still validates all newly generated rows.
        }
        const persistedFields = persistedSuggestion?.reviewFields;
        const hasPersistedFields = persistedFields
          && typeof persistedFields === "object"
          && !Array.isArray(persistedFields)
          && Object.keys(persistedFields).length > 0;
        let suggestion = hasPersistedFields
          ? mergeEditableFieldsIntoSuggestion(value.suggestion, normalizeEditableFields(persistedFields))
          : value.suggestion;
        if (hasPersistedFields) {
          const previewDigests = {};
          for (const target of ["action", "risk"]) {
            if (suggestion.writebackPreview?.[target]) previewDigests[target] = previewDigestFor(suggestion, target);
          }
          suggestion = {
            ...suggestion,
            previewDigests,
            previewDigest: previewDigests.risk ?? previewDigests.action ?? null,
            writebackPreview: suggestion.writebackPreview && suggestion.previewDigest
              ? { ...suggestion.writebackPreview, previewDigest: previewDigests.risk ?? previewDigests.action ?? null }
              : suggestion.writebackPreview,
          };
        }
        const nextContentJson = hasPersistedFields ? json(suggestion, "suggestion") : value.contentJson;
        const nextConfirmationPreviewJson = hasPersistedFields
          ? json(suggestion.writebackPreview ?? {}, "confirmationPreview", 64 * 1024)
          : value.confirmationPreviewJson;
        const nextPayloadHash = hasPersistedFields ? stableSuggestionPayloadHash(suggestion) : value.payloadHash;
        const changed = existingPayloadHash !== nextPayloadHash;
        db.prepare(`
          UPDATE ai_suggestions
             SET title = $title,
                 content = $content,
                 draft_content = $content,
                 confidence = $confidence,
                 source_id = $sourceId,
                 source_refs = $sourceRefs,
                 confirmation_preview = $confirmationPreview,
                 source = $source,
                 fallback_reason = $fallbackReason,
                 proactive_subject_type = $subjectType,
                 proactive_subject_id = $subjectId,
                 ${hasCustomerSubjectColumns ? `proactive_subject_key = $subjectKey,
                 proactive_subject_version = $subjectVersion,
                 proactive_source_digest = $sourceDigest,
                 proactive_source_refs = $subjectSourceRefs,` : ""}
                 proactive_customer_id = $customerId,
                 proactive_opportunity_id = $opportunityId,
                 proactive_rule_version = $ruleVersion,
                 proactive_priority = $priority,
                 proactive_generated_at = $generatedAt,
                 proactive_payload_hash = $payloadHash,
                 version = version + CASE WHEN $changed = 1 THEN 1 ELSE 0 END,
                 proactive_last_seen_at = $now,
                 proactive_run_id = COALESCE($runId, proactive_run_id),
                 proactive_event_id = COALESCE($eventId, proactive_event_id),
                 updated_at = $now
           WHERE id = $id AND owner = $owner
        `).run({
          $changed: changed ? 1 : 0,
          $id: existingByDedupe.id,
          $owner: value.owner,
          $title: value.title,
          $content: nextContentJson,
          $confidence: value.confidence ?? 0,
          $sourceId: value.subjectId,
          $sourceRefs: value.sourceRefsJson,
          $confirmationPreview: nextConfirmationPreviewJson,
          $source: value.source,
          $fallbackReason: value.fallbackReason,
          $subjectType: value.subjectType,
          $subjectId: value.subjectId,
          ...(hasCustomerSubjectColumns ? {
            $subjectKey: value.subjectKey,
            $subjectVersion: value.subjectVersion,
            $sourceDigest: value.sourceDigest,
            $subjectSourceRefs: value.subjectSourceRefsJson,
          } : {}),
          $customerId: value.customerId,
          $opportunityId: value.opportunityId,
          $ruleVersion: value.ruleVersion,
          $priority: value.priority,
          $generatedAt: value.generatedAt,
          $payloadHash: nextPayloadHash,
          $now: nowIso,
          $runId: value.runId,
          $eventId: value.eventId,
        });
        return { item: rowToItem(selectById(existingByDedupe.id, value.owner)), replayed: true };
      }
      const existingById = selectById(value.id);
      if (existingById) {
        throw new HttpError(409, "PROACTIVE_SUGGESTION_ID_CONFLICT", "The proactive suggestion id already exists");
      }
      db.prepare(`
        INSERT INTO ai_suggestions (
          id, version, owner, type, title, status, content, draft_content, confidence,
          source_id, source_refs, confirmation_preview, source, fallback_reason,
          created_at, updated_at,
          proactive_trigger, proactive_subject_type, proactive_subject_id,
          ${hasCustomerSubjectColumns ? `proactive_subject_key, proactive_subject_version,
          proactive_source_digest, proactive_source_refs,` : ""}
          proactive_customer_id, proactive_opportunity_id, proactive_dedupe_key,
          proactive_rule_version, proactive_priority, proactive_status,
          proactive_stale_at, proactive_snoozed_until, proactive_dismiss_reason,
          proactive_resolved_at, proactive_result_refs, proactive_run_id,
          proactive_event_id, proactive_generated_at, proactive_last_seen_at,
          proactive_failure_count, proactive_next_retry_at, proactive_payload_hash
        ) VALUES (
          $id, 1, $owner, 'opportunity_push', $title, 'pending', $content, $content, $confidence,
          $sourceId, $sourceRefs, $confirmationPreview, $source, $fallbackReason,
          $now, $now,
          $trigger, $subjectType, $subjectId,
          ${hasCustomerSubjectColumns ? `$subjectKey, $subjectVersion,
          $sourceDigest, $subjectSourceRefs,` : ""}
          $customerId, $opportunityId, $dedupeKey,
          $ruleVersion, $priority, $proactiveStatus,
          $staleAt, $snoozedUntil, $dismissReason,
          $resolvedAt, $resultRefs, $runId,
          $eventId, $generatedAt, $now,
          0, NULL, $payloadHash
        )
      `).run({
        $id: value.id,
        $owner: value.owner,
        $title: value.title,
        $content: value.contentJson,
        $confidence: value.confidence ?? 0,
        $sourceId: value.subjectId,
        $sourceRefs: value.sourceRefsJson,
        $confirmationPreview: value.confirmationPreviewJson,
        $source: value.source,
        $fallbackReason: value.fallbackReason,
        $now: nowIso,
        $trigger: value.trigger,
        $subjectType: value.subjectType,
        $subjectId: value.subjectId,
        ...(hasCustomerSubjectColumns ? {
          $subjectKey: value.subjectKey,
          $subjectVersion: value.subjectVersion,
          $sourceDigest: value.sourceDigest,
          $subjectSourceRefs: value.subjectSourceRefsJson,
        } : {}),
        $customerId: value.customerId,
        $opportunityId: value.opportunityId,
        $dedupeKey: value.dedupeKey,
        $ruleVersion: value.ruleVersion,
        $priority: value.priority,
        $proactiveStatus: value.status,
        $staleAt: value.staleAt,
        $snoozedUntil: value.snoozedUntil,
        $dismissReason: value.status === "dismissed" || value.status === "ignored"
          ? optionalText(input.dismissReason ?? input.reason, "dismissReason", 500)
          : null,
        $resolvedAt: value.status === "resolved" ? nowIso : null,
        $resultRefs: value.resultRefsJson,
        $runId: value.runId,
        $eventId: value.eventId,
        $generatedAt: value.generatedAt,
        $payloadHash: value.payloadHash,
      });
      return { item: rowToItem(selectById(value.id, value.owner)), replayed: false };
    }, { withinTransaction });
  }

  function saveWithinTransaction(input = {}) {
    return save(input, { withinTransaction: true });
  }

  function get(idValue, { owner = null } = {}) {
    const id = identifier(idValue, "suggestion id");
    const normalizedOwner = owner === null || owner === undefined ? null : identifier(owner, "owner", 200);
    return rowToItem(selectById(id, normalizedOwner));
  }

  function getByDedupe(dedupeKeyValue, { owner } = {}) {
    const normalizedOwner = identifier(owner, "owner", 200);
    const dedupeKey = identifier(dedupeKeyValue, "dedupeKey", 500);
    return rowToItem(selectByDedupe(normalizedOwner, dedupeKey));
  }

  function list({
    owner,
    status = null,
    trigger = null,
    subjectId = null,
    customerId = null,
    opportunityId = null,
    limit = 50,
    offset = 0,
  } = {}) {
    const normalizedOwner = identifier(owner, "owner", 200);
    const boundedLimit = integer(limit, "limit", { min: 1, max: 100, fallback: 50 });
    const boundedOffset = integer(offset, "offset", { min: 0, max: 1_000_000, fallback: 0 });
    const normalizedStatus = status === null || status === undefined ? null : text(status, "status", 20);
    const normalizedTrigger = trigger === null || trigger === undefined ? null : text(trigger, "trigger", 100);
    const normalizedSubject = subjectId === null || subjectId === undefined ? null : identifier(subjectId, "subjectId");
    const normalizedCustomer = customerId === null || customerId === undefined ? null : identifier(customerId, "customerId");
    const normalizedOpportunity = opportunityId === null || opportunityId === undefined ? null : identifier(opportunityId, "opportunityId");
    if (normalizedStatus !== null && !STATUS_VALUES.has(normalizedStatus)) throw new TypeError("status is invalid");
    return db.prepare(`
      SELECT * FROM ai_suggestions
       WHERE owner = $owner
         AND proactive_trigger IS NOT NULL
         AND ($status IS NULL OR proactive_status = $status)
         AND ($trigger IS NULL OR proactive_trigger = $trigger)
         AND ($subjectId IS NULL OR proactive_subject_id = $subjectId)
         AND ($customerId IS NULL OR proactive_customer_id = $customerId)
         AND ($opportunityId IS NULL OR proactive_opportunity_id = $opportunityId)
       ORDER BY proactive_priority DESC, created_at DESC, id DESC
       LIMIT $limit OFFSET $offset
    `).all({
      $owner: normalizedOwner,
      $status: normalizedStatus,
      $trigger: normalizedTrigger,
      $subjectId: normalizedSubject,
      $customerId: normalizedCustomer,
      $opportunityId: normalizedOpportunity,
      $limit: boundedLimit,
      $offset: boundedOffset,
    }).map(rowToItem);
  }

  function count({ owner, status = null, trigger = null, subjectId = null, customerId = null, opportunityId = null } = {}) {
    const normalizedOwner = identifier(owner, "owner", 200);
    const normalizedStatus = status === null || status === undefined ? null : text(status, "status", 20);
    const normalizedTrigger = trigger === null || trigger === undefined ? null : text(trigger, "trigger", 100);
    const normalizedSubject = subjectId === null || subjectId === undefined ? null : identifier(subjectId, "subjectId");
    const normalizedCustomer = customerId === null || customerId === undefined ? null : identifier(customerId, "customerId");
    const normalizedOpportunity = opportunityId === null || opportunityId === undefined ? null : identifier(opportunityId, "opportunityId");
    if (normalizedStatus !== null && !STATUS_VALUES.has(normalizedStatus)) throw new TypeError("status is invalid");
    return Number(db.prepare(`
      SELECT COUNT(*) AS count FROM ai_suggestions
       WHERE owner = $owner AND proactive_trigger IS NOT NULL
         AND ($status IS NULL OR proactive_status = $status)
         AND ($trigger IS NULL OR proactive_trigger = $trigger)
         AND ($subjectId IS NULL OR proactive_subject_id = $subjectId)
         AND ($customerId IS NULL OR proactive_customer_id = $customerId)
         AND ($opportunityId IS NULL OR proactive_opportunity_id = $opportunityId)
    `).get({
      $owner: normalizedOwner,
      $status: normalizedStatus,
      $trigger: normalizedTrigger,
      $subjectId: normalizedSubject,
      $customerId: normalizedCustomer,
      $opportunityId: normalizedOpportunity,
    }).count);
  }

  function listOwners() {
    return db.prepare(`SELECT DISTINCT owner FROM ai_suggestions
      WHERE proactive_trigger IS NOT NULL ORDER BY owner ASC`).all().map((row) => row.owner);
  }

  function expireDue({ owner = null, now: at = clockDate(clock) } = {}) {
    const current = date(at, "now");
    const nowIso = current.toISOString();
    const normalizedOwner = owner === null || owner === undefined ? null : identifier(owner, "owner", 200);
    return withImmediateTransaction(db, () => {
      const resumed = db.prepare(`
        UPDATE ai_suggestions
           SET proactive_status = 'pending', proactive_snoozed_until = NULL,
               version = version + 1, updated_at = $now
         WHERE proactive_trigger IS NOT NULL AND proactive_status IN ('snoozed', 'deferred')
           AND proactive_snoozed_until IS NOT NULL AND proactive_snoozed_until <= $now
           AND ($owner IS NULL OR owner = $owner)
      `).run({ $now: nowIso, $owner: normalizedOwner });
      const expired = db.prepare(`
        UPDATE ai_suggestions
           SET proactive_status = 'expired', version = version + 1, updated_at = $now
         WHERE proactive_trigger IS NOT NULL AND proactive_status IN ('pending', 'snoozed', 'deferred')
           AND proactive_stale_at IS NOT NULL AND proactive_stale_at <= $now
           AND ($owner IS NULL OR owner = $owner)
      `).run({ $now: nowIso, $owner: normalizedOwner });
      return { resumedCount: Number(resumed.changes), expiredCount: Number(expired.changes) };
    });
  }

  function updateLifecycle(idValue, input = {}, options = {}) {
    const id = identifier(idValue, "suggestion id");
    const owner = identifier(input.owner, "owner", 200);
    const nextStatus = text(input.status, "status", 20);
    if (!STATUS_VALUES.has(nextStatus)) throw new TypeError("status is invalid");
    const nowIso = now();
    const resultRefs = input.resultRefs === undefined ? null : json(input.resultRefs, "resultRefs", 64 * 1024);
    const snoozedUntil = input.snoozedUntil === undefined
      ? null
      : iso(input.snoozedUntil, "snoozedUntil", { nullable: true });
    const dismissReason = input.dismissReason === undefined ? null : optionalText(input.dismissReason, "dismissReason", 500);
    return runMutation(db, () => {
      const row = selectById(id, owner);
      if (!row || row.proactive_trigger === null || row.proactive_trigger === undefined) {
        throw new HttpError(404, "PROACTIVE_SUGGESTION_NOT_FOUND", "The proactive suggestion was not found");
      }
      const currentStatus = row.proactive_status ?? "pending";
      if (!STATUS_VALUES.has(currentStatus)) {
        throw lifecycleError(row.proactive_status ?? "unknown");
      }
      if (input.expectedVersion !== undefined && input.expectedVersion !== null) {
        const expectedVersion = integer(input.expectedVersion, "expectedVersion", { min: 1 });
        if (Number(row.version ?? 1) !== expectedVersion) {
          throw new HttpError(409, "PROACTIVE_SUGGESTION_VERSION_CONFLICT", "The proactive suggestion was updated by another request", {
            currentVersion: Number(row.version ?? 1),
          });
        }
      }
      const allowed = LIFECYCLE_TRANSITIONS[currentStatus] ?? new Set();
      if (!allowed.has(nextStatus)) throw lifecycleError(currentStatus);
      // Repeating the same state with the same optional values is an
      // idempotent replay.  It must not advance the suggestion version or
      // invalidate an already-open confirmation preview.
      const sameSnooze = (row.proactive_snoozed_until ?? null) === snoozedUntil;
      const sameDismiss = (row.proactive_dismiss_reason ?? null) === dismissReason;
      const sameResultRefs = resultRefs === null || row.proactive_result_refs === resultRefs;
      if (currentStatus === nextStatus && sameSnooze && sameDismiss && sameResultRefs) {
        return rowToItem(selectById(id, owner));
      }
      db.prepare(`
        UPDATE ai_suggestions SET
          proactive_status = $status,
          proactive_snoozed_until = CASE WHEN $status IN ('snoozed', 'deferred') THEN $snoozedUntil ELSE NULL END,
          proactive_dismiss_reason = CASE WHEN $status IN ('dismissed', 'ignored') THEN $dismissReason ELSE NULL END,
          proactive_resolved_at = CASE WHEN $status = 'resolved' THEN $now ELSE NULL END,
          proactive_result_refs = COALESCE($resultRefs, proactive_result_refs),
          version = version + 1,
          updated_at = $now
        WHERE id = $id AND owner = $owner
      `).run({ $id: id, $owner: owner, $status: nextStatus, $snoozedUntil: snoozedUntil, $dismissReason: dismissReason, $now: nowIso, $resultRefs: resultRefs });
      return rowToItem(selectById(id, owner));
    }, options);
  }

  /**
   * Persist the human-editable fields used by the confirmation preview.  The
   * edit is a new suggestion revision: the JSON payload, writeback preview,
   * payload hash and ledger version move together, while lifecycle status is
   * preserved.  Callers should invalidate open confirmation previews after
   * this method returns because their digest was computed from the old
   * revision.
   */
  function updateFields(idValue, input = {}, options = {}) {
    const id = identifier(idValue, "suggestion id");
    const owner = identifier(input.owner, "owner", 200);
    const fields = normalizeEditableFields(input.fields ?? input);
    const nowIso = now();
    return runMutation(db, () => {
      const row = selectById(id, owner);
      if (!row || row.proactive_trigger === null || row.proactive_trigger === undefined) {
        throw new HttpError(404, "PROACTIVE_SUGGESTION_NOT_FOUND", "The proactive suggestion was not found");
      }
      if (input.expectedVersion !== undefined && input.expectedVersion !== null) {
        const expectedVersion = integer(input.expectedVersion, "expectedVersion", { min: 1 });
        if (Number(row.version ?? 1) !== expectedVersion) {
          throw new HttpError(409, "PROACTIVE_SUGGESTION_VERSION_CONFLICT", "The proactive suggestion was updated by another request", {
            currentVersion: Number(row.version ?? 1),
          });
        }
      }
      // A version guard without editable fields is a read-only validation
      // request. Do not materialize an empty reviewFields object or advance
      // the suggestion revision when there is no semantic change.
      if (Object.keys(fields).length === 0) return rowToItem(row);
      const currentSuggestion = parsed(row.content, {});
      const nextSuggestion = mergeEditableFieldsIntoSuggestion(currentSuggestion, fields);
      const previewDigests = {};
      for (const target of ["action", "risk"]) {
        if (nextSuggestion.writebackPreview?.[target]) previewDigests[target] = previewDigestFor(nextSuggestion, target);
      }
      nextSuggestion.previewDigests = previewDigests;
      nextSuggestion.previewDigest = previewDigests.risk ?? previewDigests.action ?? null;
      if (nextSuggestion.writebackPreview && nextSuggestion.previewDigest) {
        nextSuggestion.writebackPreview = {
          ...nextSuggestion.writebackPreview,
          previewDigest: nextSuggestion.previewDigest,
        };
      }
      const contentJson = json(nextSuggestion, "suggestion");
      const preview = nextSuggestion.writebackPreview ?? {};
      const confirmationPreviewJson = json(preview, "confirmationPreview", 64 * 1024);
      const payloadHash = stableSuggestionPayloadHash(nextSuggestion);
      let existingPayloadHash = row.proactive_payload_hash;
      try {
        existingPayloadHash = stableSuggestionPayloadHash(parsed(row.content, {}));
      } catch {
        // Fall back to the stored hash for legacy malformed content.
      }
      const changed = existingPayloadHash !== payloadHash;
      if (!changed) return rowToItem(row);
      db.prepare(`
        UPDATE ai_suggestions SET
          content = $content,
          draft_content = $content,
          confirmation_preview = $confirmationPreview,
          proactive_payload_hash = $payloadHash,
          version = version + 1,
          updated_at = $now
        WHERE id = $id AND owner = $owner
      `).run({
        $content: contentJson,
        $confirmationPreview: confirmationPreviewJson,
        $payloadHash: payloadHash,
        $now: nowIso,
        $id: id,
        $owner: owner,
      });
      return rowToItem(selectById(id, owner));
    }, options);
  }

  function snooze(id, input = {}) {
    const until = date(input.until, "until");
    if (until.getTime() <= clockDate(clock).getTime()) throw new TypeError("until must be in the future");
    return updateLifecycle(id, { owner: input.owner, status: "snoozed", snoozedUntil: until });
  }

  function dismiss(id, input = {}) {
    return updateLifecycle(id, { owner: input.owner, status: "dismissed", dismissReason: input.reason ?? input.dismissReason ?? null });
  }

  function ignore(id, input = {}) {
    return updateLifecycle(id, { owner: input.owner, status: "ignored", dismissReason: input.reason ?? input.dismissReason ?? null });
  }

  function resolve(id, input = {}) {
    return updateLifecycle(id, { owner: input.owner, status: "resolved", resultRefs: input.resultRefs ?? [] });
  }

  function reopen(id, input = {}) {
    return updateLifecycle(id, { owner: input.owner, status: "pending" });
  }

  function markFailed(id, input = {}) {
    const item = updateLifecycle(id, { owner: input.owner, status: "failed" });
    return item;
  }

  return Object.freeze({
    save,
    saveWithinTransaction,
    upsert: save,
    get,
    getByDedupe,
    list,
    count,
    listOwners,
    expireDue,
    updateLifecycle,
    updateFields,
    snooze,
    dismiss,
    ignore,
    resolve,
    reopen,
    markFailed,
  });
}

export { canonical, rowToItem };
