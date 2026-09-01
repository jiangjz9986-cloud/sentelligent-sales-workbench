import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { insertAudit } from "../audit/auditRepository.js";
import { addDays, shanghaiDateParts, weekStartOf } from "../dailyDigest/digestContent.js";

const MAX_ARRAY_ITEMS = 100;
const VIRTUAL_WEEKLY_ID = /^weekly:(\d{4}-\d{2}-\d{2}):([a-f0-9]{24})(?::([1-9]\d{0,8}))?$/u;

export class QuickRecordConfirmationRepositoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "QuickRecordConfirmationRepositoryError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new QuickRecordConfirmationRepositoryError(code, message);
}

function assertDb(db) {
  if (!db || typeof db.prepare !== "function") {
    throw new TypeError("A synchronous SQLite connection is required");
  }
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function parseObject(value, name) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail("DATA_INTEGRITY_ERROR", `${name} must contain a JSON object`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof QuickRecordConfirmationRepositoryError) throw error;
    fail("DATA_INTEGRITY_ERROR", `${name} contains invalid JSON`);
  }
}

function parseArray(value, name) {
  try {
    const parsed = JSON.parse(value ?? "[]");
    if (!Array.isArray(parsed) || parsed.length > MAX_ARRAY_ITEMS) {
      fail("DATA_INTEGRITY_ERROR", `${name} must contain a bounded JSON array`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof QuickRecordConfirmationRepositoryError) throw error;
    fail("DATA_INTEGRITY_ERROR", `${name} contains invalid JSON`);
  }
}

function boundedText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function appendUnique(values, value) {
  const next = boundedText(value);
  if (!next || values.some((item) => item === next) || values.length >= MAX_ARRAY_ITEMS) {
    return clone(values);
  }
  return [...clone(values), next];
}

function ownerHash(owner) {
  return createHash("sha256").update(owner, "utf8").digest("hex").slice(0, 24);
}

function virtualWeeklyId(owner, weekStart, generation = 0) {
  const base = `weekly:${weekStart}:${ownerHash(owner)}`;
  return generation === 0 ? base : `${base}:${generation}`;
}

function virtualWeeklyPeriod(owner, entityId) {
  const match = VIRTUAL_WEEKLY_ID.exec(entityId);
  if (!match || match[2] !== ownerHash(owner)) return null;
  const weekStart = weekStartOf(match[1]);
  if (weekStart !== match[1]) return null;
  return { periodStart: weekStart, periodEnd: addDays(weekStart, 6) };
}

function availableVirtualWeeklyId(db, owner, weekStart) {
  const base = virtualWeeklyId(owner, weekStart);
  const occupied = new Set();
  const rows = db.prepare(`
    SELECT id, owner, deleted_at, updated_at FROM weekly_reports
    WHERE id = $base OR id LIKE $prefix
  `).all({ $base: base, $prefix: `${base}:%` });
  // Preserve the existing optimistic-conflict behavior for an active report
  // (for example, a `ready` report): only soft-deleted rows may be replaced by
  // a new generation. Returning an already-active virtual id is important when
  // the canonical row was deleted and a prior replacement (such as `:1`) has
  // since become ready; allocating `:2` would silently bypass that report and
  // turn the next confirmation into a different draft instead of the expected
  // target_changed result.
  const activeOwned = rows
    .filter((row) => row.deleted_at === null && row.owner === owner)
    .sort((left, right) => (
      String(right.updated_at ?? "").localeCompare(String(left.updated_at ?? ""))
      || String(right.id).localeCompare(String(left.id))
    ));
  const activeVirtual = activeOwned.find((row) => {
    const match = VIRTUAL_WEEKLY_ID.exec(row.id);
    return match && match[1] === weekStart && match[2] === ownerHash(owner);
  });
  if (activeVirtual) return activeVirtual.id;
  for (const row of rows) {
    const match = VIRTUAL_WEEKLY_ID.exec(row.id);
    if (!match || match[1] !== weekStart || match[2] !== ownerHash(owner)) continue;
    occupied.add(match[3] ? Number(match[3]) : 0);
  }
  for (let generation = 0; generation <= occupied.size; generation += 1) {
    if (!occupied.has(generation)) return virtualWeeklyId(owner, weekStart, generation);
  }
  fail("DATA_INTEGRITY_ERROR", "weekly report virtual id allocation failed");
}

function recordDate(row) {
  // Older callers could persist an empty occurred_at string. Treat that legacy
  // representation as absent and fall back to the trusted row timestamp; new
  // HTTP writes reject empty/invalid date-time values at the request boundary.
  const value = boundedText(row.occurred_at) ?? row.created_at;
  try {
    return shanghaiDateParts(value).date;
  } catch {
    fail("DATA_INTEGRITY_ERROR", "quick record date is invalid");
  }
}

function latestInsight(db, quickRecordId) {
  return db.prepare(`
    SELECT * FROM ai_insights
    WHERE quick_record_id = $quickRecordId
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `).get({ $quickRecordId: quickRecordId });
}

function usesAnonymousGlobalTargets(owner, options) {
  return options?.anonymousGlobalTargets === true && owner === "anonymous";
}

function activeCustomer(db, owner, id, options) {
  if (!id) return null;
  const globalTargets = usesAnonymousGlobalTargets(owner, options);
  return db.prepare(`
    SELECT * FROM customers
    WHERE id = $id${globalTargets ? "" : " AND owner = $owner"} AND deleted_at IS NULL
  `).get(globalTargets ? { $id: id } : { $id: id, $owner: owner }) ?? null;
}

function activeOpportunity(db, owner, id, options) {
  if (!id) return null;
  const globalTargets = usesAnonymousGlobalTargets(owner, options);
  return db.prepare(`
    SELECT * FROM opportunities
    WHERE id = $id${globalTargets ? "" : " AND owner = $owner"} AND deleted_at IS NULL
  `).get(globalTargets ? { $id: id } : { $id: id, $owner: owner }) ?? null;
}

function activeLinkedOpportunity(db, owner, id, options) {
  const opportunity = activeOpportunity(db, owner, id, options);
  if (!opportunity) return null;
  return activeCustomer(db, owner, opportunity.customer_id, options) ? opportunity : null;
}

function failInvalidQuickRecordRelationship() {
  fail(
    "QUICK_RECORD_RELATIONSHIP_INVALID",
    "Saved quick-record links are not confirmable",
  );
}

function exactModelName(entity, value) {
  return entity && typeof value === "string" && value === entity.name ? entity : null;
}

function confirmationTargets(db, owner, record, analysis, options) {
  const explicitCustomerId = boundedText(record.customer_id);
  const explicitOpportunityId = boundedText(record.opportunity_id);
  const candidateCustomerId = boundedText(analysis.customer?.id);
  const candidateOpportunityId = boundedText(analysis.opportunity?.id);

  const customer = explicitCustomerId
    ? activeCustomer(db, owner, explicitCustomerId, options)
    : exactModelName(
      activeCustomer(db, owner, candidateCustomerId, options),
      analysis.customer?.value,
    );
  if (explicitCustomerId && !customer) failInvalidQuickRecordRelationship();

  const opportunity = explicitOpportunityId
    ? activeLinkedOpportunity(db, owner, explicitOpportunityId, options)
    : exactModelName(
      activeLinkedOpportunity(db, owner, candidateOpportunityId, options),
      analysis.opportunity?.value,
    );
  if (explicitOpportunityId && !opportunity) failInvalidQuickRecordRelationship();

  if (customer && opportunity && opportunity.customer_id !== customer.id) {
    failInvalidQuickRecordRelationship();
  }

  return { customer, opportunity };
}

function evidenceFromAnalysis(analysis, insightId, quickRecordId) {
  const sections = ["request", "feedback", "risk", "action"];
  const evidence = [];
  for (const section of sections) {
    const item = analysis?.summary?.[section];
    const value = boundedText(item?.text);
    if (!value) continue;
    evidence.push({
      key: `summary_${section}`,
      label: boundedText(item?.title) ?? section,
      value,
      sourceRef: { type: "quick_record_insight", id: insightId },
    });
  }
  if (evidence.length === 0) {
    const raw = boundedText(analysis?.rawContent);
    if (raw) {
      evidence.push({
        key: "quick_record",
        label: "快速记录",
        value: raw,
        sourceRef: { type: "quick_record", id: quickRecordId },
      });
    }
  }
  return evidence;
}

function sourceKeys(evidence, preferred) {
  return evidence.some((item) => item.key === preferred)
    ? [preferred]
    : evidence.length > 0
      ? [evidence[0].key]
      : [];
}

function addChange(changes, change) {
  if (isDeepStrictEqual(change.before, change.after)) return;
  changes.push(change);
}

function weeklyTarget(db, owner, date) {
  const row = db.prepare(`
    SELECT * FROM weekly_reports
    WHERE owner = $owner
      AND deleted_at IS NULL
      AND status IN ('draft', 'saved')
      AND date($date) BETWEEN date(period_start) AND date(period_end)
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `).get({ $owner: owner, $date: date });
  if (row) {
    return {
      id: row.id,
      version: Number(row.version),
      entries: parseArray(row.entries_json, "weekly_reports.entries_json"),
    };
  }
  const weekStart = weekStartOf(date);
  return { id: availableVirtualWeeklyId(db, owner, weekStart), version: 1, entries: [] };
}

function buildDraft(db, owner, quickRecordId, options) {
  const record = db.prepare(`
    SELECT * FROM quick_records
    WHERE id = $id AND owner = $owner AND voided_at IS NULL
  `).get({ $id: quickRecordId, $owner: owner });
  if (!record) return null;
  const insightRow = latestInsight(db, quickRecordId);
  if (!insightRow) return null;
  const analysis = parseObject(insightRow.analysis_json, "ai_insights.analysis_json");
  if (!analysis.summary || typeof analysis.summary !== "object" || Array.isArray(analysis.summary)) {
    fail("DATA_INTEGRITY_ERROR", "saved quick-record analysis has no summary");
  }

  const evidence = evidenceFromAnalysis(analysis, insightRow.id, quickRecordId);
  if (evidence.length === 0) {
    fail("DATA_INTEGRITY_ERROR", "saved quick-record analysis has no usable evidence");
  }
  const requestText = boundedText(analysis.summary?.request?.text);
  const actionText = boundedText(analysis.summary?.action?.text);
  const changes = [];
  const { customer, opportunity } = confirmationTargets(db, owner, record, analysis, options);

  if (customer && requestText) {
    const before = parseArray(customer.needs, "customers.needs");
    addChange(changes, {
      id: "customer-needs",
      target: "customer",
      entityId: customer.id,
      field: "needs",
      label: "客户诉求",
      before,
      after: appendUnique(before, requestText),
      entityVersion: Number(customer.version),
      evidenceKeys: sourceKeys(evidence, "summary_request"),
    });
  }

  if (opportunity && requestText) {
    const before = parseArray(opportunity.requirements, "opportunities.requirements");
    addChange(changes, {
      id: "opportunity-requirements",
      target: "opportunity",
      entityId: opportunity.id,
      field: "requirements",
      label: "商机需求",
      before,
      after: appendUnique(before, requestText),
      entityVersion: Number(opportunity.version),
      evidenceKeys: sourceKeys(evidence, "summary_request"),
    });
  }

  const weekly = weeklyTarget(db, owner, recordDate(record));
  const weeklyEntry = boundedText(analysis.weekly?.value)
    ? `${analysis.weekly.value}：${requestText ?? boundedText(analysis.summary?.feedback?.text) ?? record.raw_content}`
    : requestText ?? boundedText(analysis.summary?.feedback?.text) ?? boundedText(record.raw_content);
  if (weeklyEntry) {
    addChange(changes, {
      id: "weekly-entry",
      target: "weekly",
      entityId: weekly.id,
      field: "entries",
      label: "周报条目",
      before: weekly.entries,
      after: appendUnique(weekly.entries, weeklyEntry),
      entityVersion: weekly.version,
      evidenceKeys: sourceKeys(evidence, "summary_request"),
    });
  }

  const suggestedRelation = analysis.customerTemperature?.suggestedValue
    ?? analysis.temperatureSuggestion?.suggestedValue;
  if (
    customer
    && Number.isSafeInteger(suggestedRelation)
    && suggestedRelation >= 0
    && suggestedRelation <= 100
  ) {
    addChange(changes, {
      id: "customer-temperature",
      target: "customer_temperature",
      entityId: customer.id,
      field: "relation",
      label: "客户温度（需独立确认）",
      before: Number(customer.relation),
      after: suggestedRelation,
      entityVersion: Number(customer.version),
      evidenceKeys: sourceKeys(evidence, "summary_feedback"),
    });
  }

  if (actionText) {
    const action = db.prepare(`
      SELECT id, title, version FROM action_items
      WHERE source_record_id = $quickRecordId
        AND owner = $owner
        AND deleted_at IS NULL
      LIMIT 1
    `).get({ $quickRecordId: quickRecordId, $owner: owner });
    addChange(changes, {
      id: "action-suggestion",
      target: "action",
      entityId: action?.id ?? `action:${quickRecordId}`,
      field: "title",
      label: "待办建议（仅供参考）",
      before: action?.title ?? "尚未建立待办",
      after: actionText,
      entityVersion: Number(action?.version ?? record.version),
      evidenceKeys: sourceKeys(evidence, "summary_action"),
    });
  }

  const financial = analysis.financial;
  if (
    financial
    && Number.isSafeInteger(financial.amountCents)
    && financial.amountCents >= 0
  ) {
    addChange(changes, {
      id: "financial-suggestion",
      target: "financial",
      entityId: boundedText(financial.expenseId) ?? `financial:${quickRecordId}`,
      field: "amountCents",
      label: "财务建议（仅供参考）",
      before: Number.isSafeInteger(financial.currentAmountCents) ? financial.currentAmountCents : 0,
      after: financial.amountCents,
      entityVersion: Number.isSafeInteger(financial.version) && financial.version > 0
        ? financial.version
        : Number(record.version),
      evidenceKeys: sourceKeys(evidence, "summary_request"),
    });
  }

  if (changes.length === 0) {
    fail("NO_CONFIRMATION_CHANGES", "saved quick-record analysis contains no new confirmable change");
  }

  return {
    owner,
    hasUnsavedChanges: false,
    quickRecord: {
      id: record.id,
      owner,
      version: Number(record.version),
      status: record.status,
      confirmationPreviewId: record.confirmation_preview_id ?? null,
      confirmationPreviewStatus: record.confirmation_preview_status ?? null,
      voidedAt: record.voided_at ?? null,
    },
    analysis: {
      id: insightRow.id,
      status: "ready_for_confirmation",
      summary: clone(analysis.summary),
      evidence,
      changes,
    },
  };
}

function storedPreviewFromRow(row) {
  if (!row) return null;
  const item = parseObject(row.preview_json, "quick_record_confirmation_previews.preview_json");
  if (
    item.id !== row.id
    || item.owner !== row.owner
    || item.quickRecordId !== row.quick_record_id
    || item.draftHash !== row.draft_hash
    || item.identity !== row.identity
    || item.revision !== Number(row.revision)
    || item.status !== row.status
  ) {
    fail("DATA_INTEGRITY_ERROR", "confirmation preview columns do not match preview JSON");
  }
  return item;
}

function currentWriteValue(db, owner, item, options) {
  if (item.target === "customer" && item.field === "needs") {
    const row = activeCustomer(db, owner, item.entityId, options);
    return row ? {
      owner,
      entityId: row.id,
      field: "needs",
      version: Number(row.version),
      value: parseArray(row.needs, "customers.needs"),
    } : null;
  }
  if (item.target === "opportunity" && item.field === "requirements") {
    const row = activeOpportunity(db, owner, item.entityId, options);
    return row ? {
      owner,
      entityId: row.id,
      field: "requirements",
      version: Number(row.version),
      value: parseArray(row.requirements, "opportunities.requirements"),
    } : null;
  }
  if (item.target === "weekly" && item.field === "entries") {
    const row = db.prepare(`
      SELECT * FROM weekly_reports
      WHERE id = $id AND owner = $owner AND deleted_at IS NULL
    `).get({ $id: item.entityId, $owner: owner });
    if (row) {
      return {
        owner,
        entityId: row.id,
        field: "entries",
        version: Number(row.version),
        value: parseArray(row.entries_json, "weekly_reports.entries_json"),
      };
    }
    const period = virtualWeeklyPeriod(owner, item.entityId);
    return period ? {
      owner,
      entityId: item.entityId,
      field: "entries",
      version: 1,
      value: [],
    } : null;
  }
  return null;
}

function updateExistingTarget(db, owner, item, expectedVersion, value, options) {
  let result;
  const globalTargets = usesAnonymousGlobalTargets(owner, options);
  if (item.target === "customer" && item.field === "needs") {
    result = db.prepare(`
      UPDATE customers
      SET needs = $value, version = version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $id${globalTargets ? "" : " AND owner = $owner"}
        AND version = $expectedVersion AND deleted_at IS NULL
    `).run(globalTargets
      ? { $value: JSON.stringify(value), $id: item.entityId, $expectedVersion: expectedVersion }
      : { $value: JSON.stringify(value), $id: item.entityId, $owner: owner, $expectedVersion: expectedVersion });
  } else if (item.target === "opportunity" && item.field === "requirements") {
    result = db.prepare(`
      UPDATE opportunities
      SET requirements = $value, version = version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $id${globalTargets ? "" : " AND owner = $owner"}
        AND version = $expectedVersion AND deleted_at IS NULL
    `).run(globalTargets
      ? { $value: JSON.stringify(value), $id: item.entityId, $expectedVersion: expectedVersion }
      : { $value: JSON.stringify(value), $id: item.entityId, $owner: owner, $expectedVersion: expectedVersion });
  } else if (item.target === "weekly" && item.field === "entries") {
    result = db.prepare(`
      UPDATE weekly_reports
      SET entries_json = $value, version = version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $id AND owner = $owner AND version = $expectedVersion AND deleted_at IS NULL
    `).run({
      $value: JSON.stringify(value), $id: item.entityId, $owner: owner, $expectedVersion: expectedVersion,
    });
  } else {
    fail("TARGET_NOT_WRITABLE", "confirmation target is not writable through this repository");
  }
  return Number(result.changes) === 1;
}

export function createQuickRecordConfirmationRepositories(db, {
  anonymousGlobalTargets = false,
} = {}) {
  assertDb(db);
  if (typeof anonymousGlobalTargets !== "boolean") {
    throw new TypeError("anonymousGlobalTargets must be a boolean");
  }
  const targetOptions = Object.freeze({ anonymousGlobalTargets });

  const draftRepository = {
    get({ owner, quickRecordId }) {
      return buildDraft(db, owner, quickRecordId, targetOptions);
    },
  };

  const previewRepository = {
    findByDraft({ owner, quickRecordId, draftHash }) {
      return storedPreviewFromRow(db.prepare(`
        SELECT * FROM quick_record_confirmation_previews
        WHERE owner = $owner AND quick_record_id = $quickRecordId AND draft_hash = $draftHash
      `).get({ $owner: owner, $quickRecordId: quickRecordId, $draftHash: draftHash }));
    },

    create(item) {
      const existing = this.findByDraft({
        owner: item.owner,
        quickRecordId: item.quickRecordId,
        draftHash: item.draftHash,
      });
      if (existing) return { item: existing, replayed: true };
      db.prepare(`
        INSERT INTO quick_record_confirmation_previews (
          id, owner, quick_record_id, draft_hash, identity, revision, status,
          preview_json, created_at, updated_at
        ) VALUES (
          $id, $owner, $quickRecordId, $draftHash, $identity, $revision, $status,
          $previewJson, $createdAt, $updatedAt
        )
      `).run({
        $id: item.id,
        $owner: item.owner,
        $quickRecordId: item.quickRecordId,
        $draftHash: item.draftHash,
        $identity: item.identity,
        $revision: item.revision,
        $status: item.status,
        $previewJson: JSON.stringify(item),
        $createdAt: item.createdAt,
        $updatedAt: item.updatedAt,
      });
      const linked = db.prepare(`
        UPDATE quick_records
        SET confirmation_preview_id = $previewId,
            confirmation_preview_status = $status
        WHERE id = $quickRecordId AND owner = $owner AND voided_at IS NULL
      `).run({
        $previewId: item.id,
        $status: item.status,
        $quickRecordId: item.quickRecordId,
        $owner: item.owner,
      });
      if (Number(linked.changes) !== 1) {
        fail("NOT_FOUND", "quick record disappeared while creating its confirmation preview");
      }
      return { item: clone(item), replayed: false };
    },

    get({ owner, previewId }) {
      return storedPreviewFromRow(db.prepare(`
        SELECT * FROM quick_record_confirmation_previews
        WHERE id = $id AND owner = $owner
      `).get({ $id: previewId, $owner: owner }));
    },

    replace({ owner, previewId, identity, expectedRevision, item }) {
      if (item.id !== previewId || item.owner !== owner || item.revision !== expectedRevision + 1) {
        return null;
      }
      const result = db.prepare(`
        UPDATE quick_record_confirmation_previews
        SET identity = $nextIdentity,
            revision = $nextRevision,
            status = $status,
            preview_json = $previewJson,
            updated_at = $updatedAt
        WHERE id = $id AND owner = $owner AND identity = $identity AND revision = $expectedRevision
      `).run({
        $nextIdentity: item.identity,
        $nextRevision: item.revision,
        $status: item.status,
        $previewJson: JSON.stringify(item),
        $updatedAt: item.updatedAt,
        $id: previewId,
        $owner: owner,
        $identity: identity,
        $expectedRevision: expectedRevision,
      });
      if (Number(result.changes) !== 1) return null;
      const linked = db.prepare(`
        UPDATE quick_records
        SET confirmation_preview_id = $previewId,
            confirmation_preview_status = $status
        WHERE id = $quickRecordId AND owner = $owner AND voided_at IS NULL
      `).run({
        $previewId: previewId,
        $status: item.status,
        $quickRecordId: item.quickRecordId,
        $owner: owner,
      });
      if (Number(linked.changes) !== 1) {
        fail("NOT_FOUND", "quick record disappeared while updating its confirmation preview");
      }
      return clone(item);
    },
  };

  const writeRepository = {
    read({ owner, item }) {
      return currentWriteValue(db, owner, item, targetOptions);
    },

    apply({ owner, item, expectedVersion, expectedValue, value, quickRecordId }) {
      if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) {
        fail("INVALID_WRITE_VALUE", "confirmation write value must be a bounded array");
      }
      const current = currentWriteValue(db, owner, item, targetOptions);
      if (!current) return { notFound: true };
      if (current.version !== expectedVersion || !isDeepStrictEqual(current.value, expectedValue)) {
        return { conflict: true, current };
      }

      // A ready (or otherwise terminal/non-editable) weekly report must never
      // be written through a stale virtual target, even when its version and
      // entries still happen to look like the empty generation-1 baseline.
      // Returning a normal repository conflict lets the service preserve its
      // target_changed response and keeps the row untouched.
      if (item.target === "weekly" && item.field === "entries") {
        const row = db.prepare(`
          SELECT status FROM weekly_reports
          WHERE id = $id AND owner = $owner AND deleted_at IS NULL
        `).get({ $id: item.entityId, $owner: owner });
        if (row && !["draft", "saved"].includes(row.status)) {
          return { conflict: true, current };
        }
      }

      if (item.target === "weekly" && virtualWeeklyPeriod(owner, item.entityId)) {
        const period = virtualWeeklyPeriod(owner, item.entityId);
        try {
          db.prepare(`
            INSERT INTO weekly_reports (
              id, owner, period_start, period_end, status, content, source_refs,
              entries_json, version
            ) VALUES (
              $id, $owner, $periodStart, $periodEnd, 'draft', '', $sourceRefs,
              $entriesJson, $version
            )
          `).run({
            $id: item.entityId,
            $owner: owner,
            $periodStart: period.periodStart,
            $periodEnd: period.periodEnd,
            $sourceRefs: JSON.stringify([{ type: "quick_record", id: quickRecordId }]),
            $entriesJson: JSON.stringify(value),
            $version: expectedVersion + 1,
          });
        } catch (error) {
          const latest = currentWriteValue(db, owner, item, targetOptions);
          if (latest && latest.version !== expectedVersion) return { conflict: true, current: latest };
          throw error;
        }
      } else if (!updateExistingTarget(db, owner, item, expectedVersion, value, targetOptions)) {
        const latest = currentWriteValue(db, owner, item, targetOptions);
        return latest ? { conflict: true, current: latest } : { notFound: true };
      }
      const updated = currentWriteValue(db, owner, item, targetOptions);
      return updated ? { item: updated } : { notFound: true };
    },
  };

  const auditRepository = {
    append(entry) {
      const actor = entry.confirmedBy ?? entry.cancelledBy;
      return insertAudit(db, {
        action: entry.action,
        entityType: "quick_record_confirmation_preview",
        entityId: entry.previewId,
        actor,
        before: entry.before ?? {
          suggestionIdentity: entry.previousSuggestionIdentity,
          status: "open",
        },
        after: entry.after ?? {
          suggestionIdentity: entry.suggestionIdentity,
          confirmedAt: entry.confirmedAt ?? null,
          cancelledAt: entry.cancelledAt ?? null,
        },
        entityVersion: null,
        metadata: {
          owner: entry.owner,
          quickRecordId: entry.quickRecordId,
          quickRecordVersion: entry.quickRecordVersion,
          analysisVersionId: entry.analysisVersionId,
          mode: entry.mode ?? "cancel",
          itemIds: entry.itemIds ?? [],
          excludedTargets: entry.excludedTargets ?? [],
        },
      });
    },
  };

  return Object.freeze({
    draftRepository,
    previewRepository,
    writeRepository,
    auditRepository,
  });
}
