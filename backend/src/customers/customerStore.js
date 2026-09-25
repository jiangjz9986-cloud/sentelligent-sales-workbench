import { randomUUID } from "node:crypto";
import { isIP } from "node:net";

import { get, run } from "../db.js";
import { withImmediateTransaction } from "../db/transaction.js";
import { insertAudit } from "../audit/auditRepository.js";
import { HttpError } from "../http/errors.js";

/**
 * Shared customer write path. The web HTTP routes and the WeChat assistant
 * runtime both use this module so create/update/soft-delete SQL, optimistic
 * locking, and audit snapshots cannot drift between channels.
 */

const CUSTOMER_SOFT_DELETE_AUDIT_FIELDS = ["id", "version", "name", "owner", "createdAt", "updatedAt"];

function parseJson(value, fallback = []) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function json(value) {
  return JSON.stringify(value ?? []);
}

function patchValue(body, field, currentValue) {
  return Object.hasOwn(body, field) ? body[field] : currentValue;
}

function patchJsonValue(body, field, currentValue) {
  return Object.hasOwn(body, field) ? json(body[field]) : json(currentValue);
}

function normalizeTenderSources(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new HttpError(422, "VALIDATION_ERROR", "客户公告来源配置无效", { tenderSources: "array" });
  }
  const seenIds = new Set();
  const seenUrls = new Set();
  return value.map((source, index) => {
    const field = `tenderSources.${index}`;
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new HttpError(422, "VALIDATION_ERROR", "客户公告来源配置无效", { [field]: "object" });
    }
    const allowedKeys = new Set(["id", "type", "label", "url"]);
    if (Object.keys(source).some((key) => !allowedKeys.has(key))) {
      throw new HttpError(422, "VALIDATION_ERROR", "客户公告来源字段无效", { [field]: "unknown" });
    }
    const type = typeof source.type === "string" ? source.type.trim() : "";
    const url = typeof source.url === "string" ? source.url.trim() : "";
    const label = source.label === undefined ? "" : source.label;
    if (typeof label !== "string") {
      throw new HttpError(422, "VALIDATION_ERROR", "客户公告来源名称无效", { [`${field}.label`]: "string" });
    }
    if (!new Set(["hospital_official", "public_resource"]).has(type)) {
      throw new HttpError(422, "VALIDATION_ERROR", "客户公告来源类型无效", { [`${field}.type`]: "enum" });
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    const hostname = parsed?.hostname?.replace(/^\[|\]$/gu, "").toLowerCase() ?? "";
    if (
      !parsed
      || !["http:", "https:"].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || !hostname
      || hostname === "localhost"
      || hostname.endsWith(".localhost")
      || isIP(hostname)
      || url.length > 2048
      || label.length > 100
    ) {
      throw new HttpError(422, "VALIDATION_ERROR", "请输入有效的公开公告页地址", { [`${field}.url`]: "publicUrl" });
    }
    if (source.id !== undefined && (typeof source.id !== "string" || !source.id.trim())) {
      throw new HttpError(422, "VALIDATION_ERROR", "客户公告来源编号无效", { [`${field}.id`]: "string" });
    }
    const id = typeof source.id === "string" ? source.id.trim() : randomUUID();
    const urlKey = parsed.href;
    if (id.length > 120 || seenIds.has(id) || seenUrls.has(urlKey)) {
      throw new HttpError(422, "VALIDATION_ERROR", "公告来源不能重复", { [field]: "duplicate" });
    }
    seenIds.add(id);
    seenUrls.add(urlKey);
    return { id, type, label: label.trim(), url: parsed.href };
  });
}

function notFound() {
  throw new HttpError(404, "NOT_FOUND", "Requested resource was not found");
}

function throwVersionFailure(db, id) {
  const current = get(db, "SELECT version, deleted_at FROM customers WHERE id = $id", { $id: id });
  if (!current || current.deleted_at) notFound();
  throw new HttpError(409, "VERSION_CONFLICT", "The record was updated by another request", {
    currentVersion: Number(current.version),
  });
}

export function customerFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    version: Number(row.version ?? 1),
    name: row.name,
    region: row.region,
    type: row.type,
    level: row.level,
    owner: row.owner,
    contact: row.contact,
    relation: row.relation,
    stakeholders: parseJson(row.stakeholders),
    decisionChain: parseJson(row.decision_chain),
    historyProjects: parseJson(row.history_projects),
    infrastructure: parseJson(row.infrastructure),
    syncPreview: parseJson(row.sync_preview),
    budget: row.budget,
    summary: row.summary,
    needs: parseJson(row.needs),
    risks: parseJson(row.risks),
    opportunities: parseJson(row.opportunities),
    aliases: parseJson(row.aliases),
    tags: parseJson(row.tags),
    tenderSources: parseJson(row.tender_sources),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// v0.9.2 隔离：owner 传入即为硬谓词（跨账号读写查无行 → 404，先于乐观锁）；
// 省略 owner 保持全库视角（AUTH_REQUIRED=false 的单人开发模式与既有单测）。
export function getActiveCustomer(db, id, { owner = null } = {}) {
  const ownerClause = owner ? " AND owner = $owner" : "";
  return customerFromRow(get(
    db,
    `SELECT * FROM customers WHERE id = $id AND deleted_at IS NULL${ownerClause}`,
    owner ? { $id: id, $owner: owner } : { $id: id },
  ));
}

export function createCustomer(db, body, { id = randomUUID() } = {}) {
  run(
    db,
    `INSERT INTO customers (
      id, name, region, type, level, owner, contact, relation,
      stakeholders, decision_chain, history_projects, infrastructure,
      sync_preview, budget, summary, needs, risks, opportunities,
      aliases, tags, tender_sources
    ) VALUES (
      $id, $name, $region, $type, $level, $owner, $contact, $relation,
      $stakeholders, $decisionChain, $historyProjects, $infrastructure,
      $syncPreview, $budget, $summary, $needs, $risks, $opportunities,
      $aliases, $tags, $tenderSources
    )`,
    {
      $id: id,
      $name: body.name,
      $region: body.region ?? null,
      $type: body.type ?? null,
      $level: body.level ?? null,
      $owner: body.owner ?? null,
      $contact: body.contact ?? null,
      $relation: body.relation ?? 0,
      $stakeholders: json(body.stakeholders),
      $decisionChain: json(body.decisionChain),
      $historyProjects: json(body.historyProjects),
      $infrastructure: json(body.infrastructure),
      $syncPreview: json(body.syncPreview),
      $budget: body.budget ?? null,
      $summary: body.summary ?? null,
      $needs: json(body.needs),
      $risks: json(body.risks),
      $opportunities: json(body.opportunities),
      $aliases: json(body.aliases),
      $tags: json(body.tags),
      $tenderSources: json(normalizeTenderSources(body.tenderSources)),
    },
  );
  return customerFromRow(get(db, "SELECT * FROM customers WHERE id = $id", { $id: id }));
}

export function updateCustomer(db, id, body, expectedVersion, { owner = null } = {}) {
  const current = getActiveCustomer(db, id, { owner });
  if (!current) return null;

  // owner 是归属/隔离键（v0.9.2 起服务端注入、无转移功能），不再进入补丁词表。
  const result = run(
    db,
    `UPDATE customers
     SET name = $name,
         region = $region,
         type = $type,
         level = $level,
         contact = $contact,
         relation = $relation,
         stakeholders = $stakeholders,
         decision_chain = $decisionChain,
         history_projects = $historyProjects,
         infrastructure = $infrastructure,
         sync_preview = $syncPreview,
         budget = $budget,
         summary = $summary,
         needs = $needs,
         risks = $risks,
         opportunities = $opportunities,
         aliases = $aliases,
         tags = $tags,
         tender_sources = $tenderSources,
         version = version + 1,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $id
       AND version = $expectedVersion
       AND deleted_at IS NULL${owner ? " AND owner = $owner" : ""}`,
    {
      $id: id,
      $expectedVersion: expectedVersion,
      ...(owner ? { $owner: owner } : {}),
      $name: patchValue(body, "name", current.name),
      $region: patchValue(body, "region", current.region),
      $type: patchValue(body, "type", current.type),
      $level: patchValue(body, "level", current.level),
      $contact: patchValue(body, "contact", current.contact),
      $relation: patchValue(body, "relation", current.relation),
      $stakeholders: patchJsonValue(body, "stakeholders", current.stakeholders),
      $decisionChain: patchJsonValue(body, "decisionChain", current.decisionChain),
      $historyProjects: patchJsonValue(body, "historyProjects", current.historyProjects),
      $infrastructure: patchJsonValue(body, "infrastructure", current.infrastructure),
      $syncPreview: patchJsonValue(body, "syncPreview", current.syncPreview),
      $budget: patchValue(body, "budget", current.budget),
      $summary: patchValue(body, "summary", current.summary),
      $needs: patchJsonValue(body, "needs", current.needs),
      $risks: patchJsonValue(body, "risks", current.risks),
      $opportunities: patchJsonValue(body, "opportunities", current.opportunities),
      $aliases: patchJsonValue(body, "aliases", current.aliases),
      $tags: patchJsonValue(body, "tags", current.tags),
      $tenderSources: json(normalizeTenderSources(patchValue(body, "tenderSources", current.tenderSources))),
    },
  );
  if (result.changes !== 1) {
    throwVersionFailure(db, id);
  }

  return getActiveCustomer(db, id, { owner });
}

function customerSoftDeleteAuditSnapshot(entity, lifecycle = {}) {
  return {
    ...Object.fromEntries(
      CUSTOMER_SOFT_DELETE_AUDIT_FIELDS
        .filter((field) => entity[field] !== undefined)
        .map((field) => [field, entity[field]]),
    ),
    ...lifecycle,
  };
}

export function softDeleteCustomer(db, { id, expectedVersion, deletedBy, requestId, metadata = {}, owner = null }) {
  return withImmediateTransaction(db, () => {
    const beforeRow = get(
      db,
      `SELECT * FROM customers WHERE id = $id${owner ? " AND owner = $owner" : ""}`,
      owner ? { $id: id, $owner: owner } : { $id: id },
    );
    if (!beforeRow || beforeRow.deleted_at) notFound();

    const result = run(
      db,
      `UPDATE customers
       SET deleted_at = CURRENT_TIMESTAMP,
           deleted_by = $deletedBy,
           version = version + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $id
         AND version = $expectedVersion
         AND deleted_at IS NULL${owner ? " AND owner = $owner" : ""}`,
      {
        $id: id,
        $expectedVersion: expectedVersion,
        $deletedBy: deletedBy,
        ...(owner ? { $owner: owner } : {}),
      },
    );
    if (result.changes !== 1) {
      throwVersionFailure(db, id);
    }

    const afterRow = get(db, "SELECT * FROM customers WHERE id = $id", { $id: id });
    const beforeEntity = customerFromRow(beforeRow);
    const afterEntity = customerFromRow(afterRow);
    insertAudit(db, {
      action: "customer.delete",
      entityType: "customer",
      entityId: id,
      actor: deletedBy,
      metadata: {
        name: beforeEntity.name,
        region: beforeEntity.region,
        level: beforeEntity.level,
        ...metadata,
      },
      requestId,
      before: customerSoftDeleteAuditSnapshot(beforeEntity),
      after: customerSoftDeleteAuditSnapshot(afterEntity, {
        deletedAt: afterRow.deleted_at,
        deletedBy: afterRow.deleted_by,
      }),
      entityVersion: afterEntity.version,
    });
    return {
      ...afterEntity,
      deletedAt: afterRow.deleted_at,
      deletedBy: afterRow.deleted_by,
    };
  });
}

export function countActiveOpportunities(db, customerId) {
  const row = get(
    db,
    "SELECT COUNT(*) AS count FROM opportunities WHERE customer_id = $customerId AND deleted_at IS NULL",
    { $customerId: customerId },
  );
  return Number(row?.count ?? 0);
}

export function findActiveCustomerByExactName(db, { owner, name }) {
  if (typeof name !== "string" || !name.trim()) return null;
  const ownerClause = owner === undefined || owner === null ? "owner IS NULL" : "owner = $owner";
  const row = get(
    db,
    `SELECT * FROM customers WHERE name = $name AND deleted_at IS NULL AND ${ownerClause} LIMIT 1`,
    owner === undefined || owner === null ? { $name: name.trim() } : { $name: name.trim(), $owner: owner },
  );
  return customerFromRow(row);
}
