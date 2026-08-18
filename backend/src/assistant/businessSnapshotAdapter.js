import { analyzeProjectSnapshot } from "./projectAnalysis.js";
import { buildWeeklyDraft } from "../weeklyDraft.js";

const MAX_ITEMS = 100;
const BUSINESS_TIME_ZONE = "Asia/Shanghai";
const WEEKLY_REPORT_STATUSES = new Set(["draft", "saved", "ready"]);

function createBusinessDateFormatter(timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    calendar: "iso8601",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function validClockDate(clock) {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError("clock must return a valid Date");
  return new Date(value.getTime());
}

function trustedDatabaseTimestamp(value) {
  if (typeof value !== "string") return value ?? null;
  const text = value.trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d{1,3})?$/u);
  return match ? `${match[1]}T${match[2]}Z` : (text || null);
}

function requiredText(value, name, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new TypeError(`${name} is invalid`);
  }
  return value.trim();
}

function optionalText(value, max = 500) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= max ? text : null;
}

function asSafeInteger(value) {
  if (typeof value === "bigint") {
    return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function asCount(value) {
  return asSafeInteger(value) ?? 0;
}

function boundedSourceRefs(value) {
  if (typeof value !== "string") return [];
  let parsed;
  try { parsed = JSON.parse(value); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, MAX_ITEMS).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const type = optionalText(item.type, 80);
    const id = optionalText(item.id, 200);
    return type && id ? [{ type, id }] : [];
  });
}

function derivedInvoiceStatus({ reimbursementCents, confirmedCoverageCents, noInvoiceConfirmedCents }) {
  if (reimbursementCents === null || confirmedCoverageCents === null || noInvoiceConfirmedCents === null) return null;
  if (reimbursementCents > 0 && confirmedCoverageCents >= reimbursementCents) return "covered";
  if (confirmedCoverageCents > 0) return "partial";
  if (noInvoiceConfirmedCents > 0) return "missing";
  return "pending";
}

function parseJsonObject(value) {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function boundedAnalysis(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const match = (item) => item && typeof item === "object" && !Array.isArray(item)
    ? {
        id: optionalText(item.id, 200),
        value: optionalText(item.value, 200),
        meta: optionalText(item.meta, 200),
      }
    : null;
  const summaryItem = (item) => item && typeof item === "object" && !Array.isArray(item)
    ? { title: optionalText(item.title, 200), text: optionalText(item.text, 2000) }
    : null;
  return {
    customer: match(value.customer),
    opportunity: match(value.opportunity),
    summary: {
      action: summaryItem(value.summary?.action),
      risk: summaryItem(value.summary?.risk),
    },
  };
}

function isoNow(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("clock must return a valid Date");
  return date.toISOString();
}

function formatDateOnlyUtc(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function businessDateOnly(date, formatter) {
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function currentWeekStart(date, formatter) {
  const businessDate = businessDateOnly(date, formatter);
  const copy = new Date(`${businessDate}T00:00:00.000Z`);
  const day = (copy.getUTCDay() + 6) % 7;
  copy.setUTCDate(copy.getUTCDate() - day);
  return formatDateOnlyUtc(copy);
}

function normalizeWeekStart(value, now, formatter) {
  if (value === undefined || value === null || value === "" || value === "current") return currentWeekStart(now, formatter);
  const text = requiredText(value, "weekStart", 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) throw new TypeError("weekStart is invalid");
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || formatDateOnlyUtc(date) !== text || date.getUTCDay() !== 1) {
    throw new TypeError("weekStart is invalid");
  }
  return text;
}

function likePattern(value) {
  const text = requiredText(value, "query", 200).replace(/[\\%_]/gu, "\\$&");
  return `%${text}%`;
}

function customerFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: optionalText(row.name, 200),
    region: optionalText(row.region, 100),
    type: optionalText(row.type, 100),
    level: optionalText(row.level, 100),
    updatedAt: trustedDatabaseTimestamp(row.updated_at),
  };
}

function opportunityFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    customerId: row.customer_id,
    name: optionalText(row.name, 200),
    customer: optionalText(row.customer, 200),
    stage: optionalText(row.stage, 100),
    amount: optionalText(row.amount, 100),
    probability: typeof row.probability === "number"
      && Number.isSafeInteger(row.probability)
      && row.probability >= 0
      && row.probability <= 100
      ? row.probability
      : null,
    days: typeof row.days === "number" && Number.isSafeInteger(row.days) && row.days >= 0 ? row.days : null,
    risk: optionalText(row.risk, 500),
    next: optionalText(row.next, 500),
    updatedAt: trustedDatabaseTimestamp(row.updated_at),
  };
}

function scopeParams({ owner, customerId = null, opportunityId = null }, resolveBusinessOwner = (value) => value) {
  const resolvedOwner = resolveBusinessOwner(requiredText(owner, "owner"));
  if (typeof resolvedOwner !== "string" || !resolvedOwner.trim()) return null;
  return {
    $owner: resolvedOwner.trim(),
    $customerId: customerId === null || customerId === undefined || customerId === ""
      ? null
      : requiredText(customerId, "customerId"),
    $opportunityId: opportunityId === null || opportunityId === undefined || opportunityId === ""
      ? null
      : requiredText(opportunityId, "opportunityId"),
  };
}

export function createAssistantBusinessSnapshotAdapter({
  db,
  clock = () => new Date(),
  resolveBusinessOwner = (owner) => owner,
} = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("db must be a synchronous SQLite connection");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  if (typeof resolveBusinessOwner !== "function") throw new TypeError("resolveBusinessOwner must be a function");
  const businessDateFormatter = createBusinessDateFormatter(BUSINESS_TIME_ZONE);

  const customerById = db.prepare(`
    SELECT id, name, region, type, level, updated_at
    FROM customers
    WHERE id = $customerId AND owner = $owner AND deleted_at IS NULL
  `);
  const opportunityById = db.prepare(`
    SELECT opportunity.*
    FROM opportunities opportunity
    INNER JOIN customers customer ON customer.id = opportunity.customer_id AND customer.deleted_at IS NULL
    WHERE opportunity.id = $opportunityId
      AND opportunity.deleted_at IS NULL
      AND (opportunity.owner = $owner OR (opportunity.owner IS NULL AND customer.owner = $owner))
  `);

  function customerDetail({ owner, customerId }) {
    const params = scopeParams({ owner, customerId }, resolveBusinessOwner);
    if (!params) return null;
    return customerFromRow(customerById.get({ $owner: params.$owner, $customerId: params.$customerId }));
  }

  function opportunityDetail({ owner, opportunityId }) {
    const params = scopeParams({ owner, opportunityId }, resolveBusinessOwner);
    if (!params) return null;
    return opportunityFromRow(opportunityById.get({ $owner: params.$owner, $opportunityId: params.$opportunityId }));
  }

  function customerSearch({ owner, query }) {
    const normalizedOwner = resolveBusinessOwner(requiredText(owner, "owner"));
    if (typeof normalizedOwner !== "string" || !normalizedOwner.trim()) return { items: [], truncated: false };
    const pattern = likePattern(query);
    const rows = db.prepare(`
      SELECT id, name, region, type, level, updated_at
      FROM customers
      WHERE owner = $owner AND deleted_at IS NULL
        AND (name LIKE $pattern ESCAPE '\\' OR region LIKE $pattern ESCAPE '\\' OR type LIKE $pattern ESCAPE '\\')
      ORDER BY updated_at DESC, id
      LIMIT ${MAX_ITEMS + 1}
    `).all({ $owner: normalizedOwner, $pattern: pattern });
    return {
      items: rows.slice(0, MAX_ITEMS).map(customerFromRow),
      truncated: rows.length > MAX_ITEMS,
    };
  }

  function opportunitySearch({ owner, query }) {
    const normalizedOwner = resolveBusinessOwner(requiredText(owner, "owner"));
    if (typeof normalizedOwner !== "string" || !normalizedOwner.trim()) return { items: [], truncated: false };
    const pattern = likePattern(query);
    const rows = db.prepare(`
      SELECT opportunity.*, customer.name AS customer_name
      FROM opportunities opportunity
      INNER JOIN customers customer ON customer.id = opportunity.customer_id AND customer.deleted_at IS NULL
      WHERE opportunity.deleted_at IS NULL
        AND (opportunity.owner = $owner OR (opportunity.owner IS NULL AND customer.owner = $owner))
        AND (opportunity.name LIKE $pattern ESCAPE '\\' OR customer.name LIKE $pattern ESCAPE '\\')
      ORDER BY opportunity.updated_at DESC, opportunity.id
      LIMIT ${MAX_ITEMS + 1}
    `).all({ $owner: normalizedOwner, $pattern: pattern });
    return {
      items: rows.slice(0, MAX_ITEMS).map((row) => opportunityFromRow({ ...row, customer: row.customer_name })),
      truncated: rows.length > MAX_ITEMS,
    };
  }

  function actionRows(input) {
    const params = scopeParams(input, resolveBusinessOwner);
    if (!params) return { items: [], truncated: false };
    const rows = db.prepare(`
      SELECT action.id, action.customer_id, action.opportunity_id, opportunity.customer_id AS opportunity_customer_id,
             action.title, action.status, action.due, action.priority, action.updated_at
      FROM action_items action
      LEFT JOIN opportunities opportunity ON opportunity.id = action.opportunity_id AND opportunity.deleted_at IS NULL
      LEFT JOIN customers action_customer ON action_customer.id = action.customer_id AND action_customer.deleted_at IS NULL
      LEFT JOIN customers opportunity_customer ON opportunity_customer.id = opportunity.customer_id AND opportunity_customer.deleted_at IS NULL
      WHERE action.deleted_at IS NULL
        AND ($customerId IS NULL OR action.customer_id = $customerId
          OR (action.customer_id IS NULL AND opportunity.customer_id = $customerId))
        AND ($opportunityId IS NULL OR action.opportunity_id = $opportunityId)
        AND (
          (action.opportunity_id IS NOT NULL
            AND (action.customer_id IS NULL OR action.customer_id = opportunity.customer_id)
            AND (opportunity.owner = $owner OR (opportunity.owner IS NULL AND opportunity_customer.owner = $owner)))
          OR
          (action.opportunity_id IS NULL AND action.customer_id IS NOT NULL AND action_customer.owner = $owner)
        )
      ORDER BY action.updated_at DESC, action.id
      LIMIT ${MAX_ITEMS + 1}
    `).all(params);
    const mapped = rows
      .filter((row) => ["pending", "in_progress", "deferred"].includes(row.status))
      .slice(0, MAX_ITEMS)
      .map((row) => ({
        id: row.id,
        customerId: row.customer_id ?? row.opportunity_customer_id,
        opportunityId: row.opportunity_id,
        title: optionalText(row.title, 500),
        status: row.status,
        due: row.due ?? null,
        priority: optionalText(row.priority, 40),
        updatedAt: trustedDatabaseTimestamp(row.updated_at),
      }));
    return { items: mapped, truncated: rows.length > MAX_ITEMS };
  }

  function riskRows(input) {
    const params = scopeParams(input, resolveBusinessOwner);
    if (!params) return { items: [], truncated: false };
    const rows = db.prepare(`
      SELECT risk.id, risk.customer_id, risk.opportunity_id, opportunity.customer_id AS opportunity_customer_id,
             risk.title, risk.status, risk.severity, risk.score, risk.due, risk.updated_at
      FROM risk_items risk
      LEFT JOIN opportunities opportunity ON opportunity.id = risk.opportunity_id AND opportunity.deleted_at IS NULL
      LEFT JOIN customers risk_customer ON risk_customer.id = risk.customer_id AND risk_customer.deleted_at IS NULL
      LEFT JOIN customers opportunity_customer ON opportunity_customer.id = opportunity.customer_id AND opportunity_customer.deleted_at IS NULL
      WHERE risk.deleted_at IS NULL
        AND ($customerId IS NULL OR risk.customer_id = $customerId
          OR (risk.customer_id IS NULL AND opportunity.customer_id = $customerId))
        AND ($opportunityId IS NULL OR risk.opportunity_id = $opportunityId)
        AND (
          (risk.opportunity_id IS NOT NULL
            AND (risk.customer_id IS NULL OR risk.customer_id = opportunity.customer_id)
            AND (opportunity.owner = $owner OR (opportunity.owner IS NULL AND opportunity_customer.owner = $owner)))
          OR
          (risk.opportunity_id IS NULL AND risk.customer_id IS NOT NULL AND risk_customer.owner = $owner)
        )
      ORDER BY risk.score DESC, risk.updated_at DESC, risk.id
      LIMIT ${MAX_ITEMS + 1}
    `).all(params);
    const mapped = rows
      .filter((row) => ["open", "accepted", "in_progress", "deferred"].includes(row.status))
      .slice(0, MAX_ITEMS)
      .map((row) => ({
        id: row.id,
        customerId: row.customer_id ?? row.opportunity_customer_id,
        opportunityId: row.opportunity_id,
        title: optionalText(row.title, 500),
        status: row.status,
        severity: row.severity,
        score: typeof row.score === "number" && Number.isSafeInteger(row.score) && row.score >= 0 && row.score <= 100 ? row.score : null,
        due: row.due ?? null,
        updatedAt: trustedDatabaseTimestamp(row.updated_at),
      }));
    return { items: mapped, truncated: rows.length > MAX_ITEMS };
  }

  function dashboardSummary({ owner }) {
    const now = validClockDate(clock);
    const resolvedOwner = resolveBusinessOwner(requiredText(owner, "owner"));
    const normalizedOwner = typeof resolvedOwner === "string" ? resolvedOwner.trim() : "";
    const weekStart = currentWeekStart(now, businessDateFormatter);
    if (!normalizedOwner) {
      return {
        asOf: isoNow(now),
        weekStart,
        counts: { customers: 0, opportunities: 0, openActions: 0, activeRisks: 0, upcomingItineraries: 0, currentWeekExpenses: 0 },
      };
    }
    const params = { $owner: normalizedOwner, $weekStart: weekStart, $today: businessDateOnly(now, businessDateFormatter) };
    const counts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM customers WHERE owner = $owner AND deleted_at IS NULL) AS customers,
        (SELECT COUNT(*) FROM opportunities opportunity
          INNER JOIN customers customer ON customer.id = opportunity.customer_id AND customer.deleted_at IS NULL
          WHERE opportunity.deleted_at IS NULL
            AND (opportunity.owner = $owner OR (opportunity.owner IS NULL AND customer.owner = $owner))) AS opportunities,
        (SELECT COUNT(*) FROM action_items action
          LEFT JOIN opportunities opportunity ON opportunity.id = action.opportunity_id AND opportunity.deleted_at IS NULL
          LEFT JOIN customers action_customer ON action_customer.id = action.customer_id AND action_customer.deleted_at IS NULL
          LEFT JOIN customers opportunity_customer ON opportunity_customer.id = opportunity.customer_id AND opportunity_customer.deleted_at IS NULL
          WHERE action.deleted_at IS NULL AND action.status IN ('pending', 'in_progress', 'deferred')
            AND (
              (action.opportunity_id IS NOT NULL
                AND (action.customer_id IS NULL OR action.customer_id = opportunity.customer_id)
                AND (opportunity.owner = $owner OR (opportunity.owner IS NULL AND opportunity_customer.owner = $owner)))
              OR (action.opportunity_id IS NULL AND action.customer_id IS NOT NULL AND action_customer.owner = $owner)
            )) AS open_actions,
        (SELECT COUNT(*) FROM risk_items risk
          LEFT JOIN opportunities opportunity ON opportunity.id = risk.opportunity_id AND opportunity.deleted_at IS NULL
          LEFT JOIN customers risk_customer ON risk_customer.id = risk.customer_id AND risk_customer.deleted_at IS NULL
          LEFT JOIN customers opportunity_customer ON opportunity_customer.id = opportunity.customer_id AND opportunity_customer.deleted_at IS NULL
          WHERE risk.deleted_at IS NULL AND risk.status IN ('open', 'accepted', 'in_progress', 'deferred')
            AND (
              (risk.opportunity_id IS NOT NULL
                AND (risk.customer_id IS NULL OR risk.customer_id = opportunity.customer_id)
                AND (opportunity.owner = $owner OR (opportunity.owner IS NULL AND opportunity_customer.owner = $owner)))
              OR (risk.opportunity_id IS NULL AND risk.customer_id IS NOT NULL AND risk_customer.owner = $owner)
            )) AS active_risks,
        (SELECT COUNT(*) FROM visit_itineraries
          WHERE created_by = $owner AND deleted_at IS NULL AND status = 'planned' AND visit_date >= $today) AS upcoming_itineraries,
        (SELECT COUNT(*) FROM travel_expenses
          WHERE owner = $owner AND deleted_at IS NULL
            AND occurred_on BETWEEN $weekStart AND date($weekStart, '+6 days')) AS current_week_expenses
    `).get(params);
    return {
      asOf: isoNow(now),
      weekStart,
      counts: {
        customers: asCount(counts.customers),
        opportunities: asCount(counts.opportunities),
        openActions: asCount(counts.open_actions),
        activeRisks: asCount(counts.active_risks),
        upcomingItineraries: asCount(counts.upcoming_itineraries),
        currentWeekExpenses: asCount(counts.current_week_expenses),
      },
    };
  }

  function projectAnalysis({ owner, customerId = null, opportunityId = null }) {
    const params = scopeParams({ owner, customerId, opportunityId }, resolveBusinessOwner);
    if (!params) return null;
    let opportunity = null;
    let customer = null;
    if (params.$opportunityId) {
      opportunity = opportunityFromRow(opportunityById.get({
        $owner: params.$owner,
        $opportunityId: params.$opportunityId,
      }));
      if (!opportunity) return null;
      if (params.$customerId && opportunity.customerId !== params.$customerId) return null;
      customer = customerFromRow(customerById.get({
        $owner: params.$owner,
        $customerId: opportunity.customerId,
      }));
    } else if (params.$customerId) {
      customer = customerFromRow(customerById.get({
        $owner: params.$owner,
        $customerId: params.$customerId,
      }));
      if (!customer) return null;
    } else {
      throw new TypeError("customerId or opportunityId is required");
    }

    const now = validClockDate(clock);
    const scoped = { owner: params.$owner, customerId: customer?.id ?? null, opportunityId: opportunity?.id ?? null };
    const quickRecordRows = db.prepare(`
      SELECT id, occurred_at, source_channel, created_at, updated_at
      FROM quick_records
      WHERE owner = $owner AND voided_at IS NULL
        AND ($opportunityId IS NULL OR opportunity_id = $opportunityId)
        AND ($customerId IS NULL OR customer_id = $customerId OR (customer_id IS NULL AND opportunity_id = $opportunityId))
      ORDER BY COALESCE(occurred_at, created_at) DESC, id
      LIMIT ${MAX_ITEMS + 1}
    `).all({ $owner: params.$owner, $customerId: scoped.customerId, $opportunityId: scoped.opportunityId });
    const quickRecords = quickRecordRows.slice(0, MAX_ITEMS).map((row) => ({
      id: row.id,
      occurredAt: row.occurred_at ?? row.created_at,
      sourceChannel: optionalText(row.source_channel, 100),
      createdAt: trustedDatabaseTimestamp(row.created_at),
      updatedAt: trustedDatabaseTimestamp(row.updated_at),
    }));
    const expenseRows = scoped.customerId ? db.prepare(`
      SELECT expense.id, expense.occurred_on, expense.invoice_status, expense.created_at, expense.updated_at,
             COALESCE(SUM(payment.amount_cents), 0) AS actual_paid_cents,
             COALESCE(SUM(payment.reimbursement_cents), 0) AS reimbursement_cents
      FROM travel_expenses expense
      LEFT JOIN travel_expense_payments payment ON payment.expense_id = expense.id
      WHERE expense.owner = $owner AND expense.customer_id = $customerId AND expense.deleted_at IS NULL
      GROUP BY expense.id
      ORDER BY expense.occurred_on DESC, expense.id
      LIMIT ${MAX_ITEMS + 1}
    `).all({ $owner: params.$owner, $customerId: scoped.customerId }) : [];
    const expenses = expenseRows.slice(0, MAX_ITEMS).map((row) => ({
      id: row.id,
      occurredOn: row.occurred_on,
      invoiceStatus: row.invoice_status,
      actualPaidCents: asSafeInteger(row.actual_paid_cents),
      reimbursementCents: asSafeInteger(row.reimbursement_cents),
      createdAt: trustedDatabaseTimestamp(row.created_at),
      updatedAt: trustedDatabaseTimestamp(row.updated_at),
    }));

    const actionResult = actionRows(scoped);
    const riskResult = riskRows(scoped);
    const analysis = analyzeProjectSnapshot({
      asOf: isoNow(now),
      customer,
      opportunity,
      quickRecord: quickRecords,
      action: actionResult.items,
      risk: riskResult.items,
      expense: expenses,
    });
    const truncationUnknowns = [];
    if (quickRecordRows.length > MAX_ITEMS) truncationUnknowns.push({
      key: "quickRecord.truncated",
      question: "需要确认是否还有未纳入分析的拜访记录。",
      reason: `拜访记录超过 ${MAX_ITEMS} 条分析上限。`,
    });
    if (actionResult.truncated) truncationUnknowns.push({
      key: "action.truncated",
      question: "需要确认是否还有未纳入分析的行动。",
      reason: `行动超过 ${MAX_ITEMS} 条分析上限。`,
    });
    if (riskResult.truncated) truncationUnknowns.push({
      key: "risk.truncated",
      question: "需要确认是否还有未纳入分析的风险。",
      reason: `风险超过 ${MAX_ITEMS} 条分析上限。`,
    });
    if (expenseRows.length > MAX_ITEMS) truncationUnknowns.push({
      key: "expense.truncated",
      question: "需要确认是否还有未纳入分析的费用。",
      reason: `费用超过 ${MAX_ITEMS} 条分析上限。`,
    });
    return truncationUnknowns.length > 0
      ? { ...analysis, unknowns: [...truncationUnknowns, ...analysis.unknowns].slice(0, 100) }
      : analysis;
  }

  function actionRiskSummary({ owner, customerId = null, opportunityId = null }) {
    const actions = actionRows({ owner, customerId, opportunityId });
    const risks = riskRows({ owner, customerId, opportunityId });
    return {
      actions: actions.items,
      risks: risks.items,
      truncated: { actions: actions.truncated, risks: risks.truncated },
    };
  }

  function itinerarySummary({ owner }) {
    const resolvedOwner = resolveBusinessOwner(requiredText(owner, "owner"));
    const normalizedOwner = typeof resolvedOwner === "string" ? resolvedOwner.trim() : "";
    if (!normalizedOwner) return { items: [], truncated: false };
    const rows = db.prepare(`
      SELECT id, title, visit_date, status, created_at, updated_at
      FROM visit_itineraries
      WHERE created_by = $owner AND deleted_at IS NULL
      ORDER BY visit_date, updated_at DESC, id
      LIMIT ${MAX_ITEMS + 1}
    `).all({ $owner: normalizedOwner });
    const items = rows.slice(0, MAX_ITEMS).map((row) => ({
      id: row.id,
      title: optionalText(row.title, 500),
      visitDate: row.visit_date,
      status: row.status,
      createdAt: trustedDatabaseTimestamp(row.created_at),
      updatedAt: trustedDatabaseTimestamp(row.updated_at),
    }));
    return { items, truncated: rows.length > MAX_ITEMS };
  }

  function travelExpenseSummary({ owner, weekStart }) {
    const resolvedOwner = resolveBusinessOwner(requiredText(owner, "owner"));
    const normalizedOwner = typeof resolvedOwner === "string" ? resolvedOwner.trim() : "";
    const now = validClockDate(clock);
    const normalizedWeek = normalizeWeekStart(weekStart, now, businessDateFormatter);
    if (!normalizedOwner) return {
      weekStart: normalizedWeek,
      summary: {
        count: 0,
        actualPaidCents: 0,
        reimbursementCents: 0,
        confirmedCoverageCents: 0,
        missingInvoiceCents: 0,
        noInvoiceConfirmedCents: 0,
        unacknowledgedMissingCents: 0,
        missingInvoiceCount: 0,
        invalidAmountCount: 0,
      },
      items: [],
      truncated: false,
      partial: false,
      preparation: { ready: true, blockers: [] },
    };
    const rows = db.prepare(`
      SELECT expense.id, expense.occurred_on, expense.category, expense.purpose, expense.invoice_status,
             COALESCE(SUM(payment.amount_cents), 0) AS actual_paid_cents,
             COALESCE(SUM(payment.reimbursement_cents), 0) AS reimbursement_cents,
             COALESCE((
               SELECT SUM(match.allocated_cents)
               FROM invoice_matches match
               INNER JOIN invoice_documents invoice
                 ON invoice.id = match.invoice_id
                AND invoice.owner = match.owner
                AND invoice.deleted_at IS NULL
               WHERE match.owner = expense.owner
                 AND match.expense_id = expense.id
                 AND match.state = 'confirmed'
             ), 0) AS confirmed_coverage_cents,
             COALESCE((
               SELECT SUM(confirmation.amount_snapshot_cents)
               FROM travel_expense_no_invoice_confirmations confirmation
               WHERE confirmation.owner = expense.owner
                 AND confirmation.expense_id = expense.id
                 AND confirmation.revoked_at IS NULL
             ), 0) AS no_invoice_confirmed_cents
      FROM travel_expenses expense
      LEFT JOIN travel_expense_payments payment ON payment.expense_id = expense.id
      WHERE expense.owner = $owner AND expense.deleted_at IS NULL
        AND expense.occurred_on BETWEEN $weekStart AND date($weekStart, '+6 days')
      GROUP BY expense.id
      ORDER BY expense.occurred_on, expense.id
      LIMIT ${MAX_ITEMS + 1}
    `).all({ $owner: normalizedOwner, $weekStart: normalizedWeek });
    const items = rows.slice(0, MAX_ITEMS).map((row) => {
      const actualPaidCents = asSafeInteger(row.actual_paid_cents);
      const reimbursementCents = asSafeInteger(row.reimbursement_cents);
      const confirmedCoverageCents = asSafeInteger(row.confirmed_coverage_cents);
      const noInvoiceTotalCents = asSafeInteger(row.no_invoice_confirmed_cents);
      const validPair = actualPaidCents !== null
        && reimbursementCents !== null
        && reimbursementCents <= actualPaidCents
        && confirmedCoverageCents !== null
        && noInvoiceTotalCents !== null;
      const boundedCoverage = validPair ? Math.min(reimbursementCents, confirmedCoverageCents) : null;
      const missingInvoiceCents = validPair ? Math.max(0, reimbursementCents - boundedCoverage) : null;
      const noInvoiceConfirmedCents = validPair ? Math.min(missingInvoiceCents, noInvoiceTotalCents) : null;
      return {
        id: row.id,
        occurredOn: row.occurred_on,
        category: row.category,
        purpose: optionalText(row.purpose, 500),
        invoiceStatus: derivedInvoiceStatus({ reimbursementCents, confirmedCoverageCents: boundedCoverage, noInvoiceConfirmedCents }),
        actualPaidCents,
        reimbursementCents,
        confirmedCoverageCents: boundedCoverage,
        missingInvoiceCents,
        noInvoiceConfirmedCents,
        unacknowledgedMissingCents: missingInvoiceCents === null || noInvoiceConfirmedCents === null
          ? null
          : Math.max(0, missingInvoiceCents - noInvoiceConfirmedCents),
      };
    });
    let actualPaidCents = 0;
    let reimbursementCents = 0;
    let confirmedCoverageCents = 0;
    let missingInvoiceCents = 0;
    let noInvoiceConfirmedCents = 0;
    let unacknowledgedMissingCents = 0;
    let missingInvoiceCount = 0;
    let invalidAmountCount = 0;
    for (const item of items) {
      const validPair = item.actualPaidCents !== null
        && item.reimbursementCents !== null
        && item.reimbursementCents <= item.actualPaidCents
        && item.confirmedCoverageCents !== null
        && item.missingInvoiceCents !== null
        && item.noInvoiceConfirmedCents !== null
        && item.unacknowledgedMissingCents !== null;
      if (!validPair) {
        invalidAmountCount += 1;
        continue;
      }
      const nextActualPaid = actualPaidCents + item.actualPaidCents;
      const nextReimbursement = reimbursementCents + item.reimbursementCents;
      const nextConfirmedCoverage = confirmedCoverageCents + item.confirmedCoverageCents;
      const nextMissingInvoice = missingInvoiceCents + item.missingInvoiceCents;
      const nextNoInvoiceConfirmed = noInvoiceConfirmedCents + item.noInvoiceConfirmedCents;
      const nextUnacknowledgedMissing = unacknowledgedMissingCents + item.unacknowledgedMissingCents;
      if (![nextActualPaid, nextReimbursement, nextConfirmedCoverage, nextMissingInvoice, nextNoInvoiceConfirmed, nextUnacknowledgedMissing]
        .every(Number.isSafeInteger)) {
        invalidAmountCount += 1;
        continue;
      }
      actualPaidCents = nextActualPaid;
      reimbursementCents = nextReimbursement;
      confirmedCoverageCents = nextConfirmedCoverage;
      missingInvoiceCents = nextMissingInvoice;
      noInvoiceConfirmedCents = nextNoInvoiceConfirmed;
      unacknowledgedMissingCents = nextUnacknowledgedMissing;
      if (item.missingInvoiceCents > 0) missingInvoiceCount += 1;
    }
    const truncated = rows.length > MAX_ITEMS;
    const summary = {
      count: items.length,
      actualPaidCents: invalidAmountCount > 0 ? null : actualPaidCents,
      reimbursementCents: invalidAmountCount > 0 ? null : reimbursementCents,
      confirmedCoverageCents: invalidAmountCount > 0 ? null : confirmedCoverageCents,
      missingInvoiceCents: invalidAmountCount > 0 ? null : missingInvoiceCents,
      noInvoiceConfirmedCents: invalidAmountCount > 0 ? null : noInvoiceConfirmedCents,
      unacknowledgedMissingCents: invalidAmountCount > 0 ? null : unacknowledgedMissingCents,
      missingInvoiceCount,
      invalidAmountCount,
    };
    const blockers = [];
    if (summary.invalidAmountCount > 0) blockers.push("invalid_amount");
    if (summary.unacknowledgedMissingCents === null || summary.unacknowledgedMissingCents > 0) blockers.push("missing_invoice");
    if (truncated) blockers.push("truncated");
    return {
      weekStart: normalizedWeek,
      summary,
      items,
      truncated,
      partial: truncated,
      preparation: { ready: blockers.length === 0, blockers },
    };
  }

  function salesReportSummary({ owner, weekStart }) {
    const resolvedOwner = resolveBusinessOwner(requiredText(owner, "owner"));
    const normalizedOwner = typeof resolvedOwner === "string" ? resolvedOwner.trim() : "";
    const now = validClockDate(clock);
    const normalizedWeek = normalizeWeekStart(weekStart, now, businessDateFormatter);
    if (!normalizedOwner) {
      return {
        weekStart: normalizedWeek,
        reportCount: 0,
        statusCounts: { draft: 0, saved: 0, ready: 0 },
        items: [],
        truncated: false,
        partial: false,
        preparation: { ready: false, blockers: ["no_weekly_report"] },
        preview: {
          persisted: false,
          sourceRecordCount: 0,
          content: null,
          sourceRefs: [],
          truncated: false,
          preparation: { ready: false, blockers: ["no_business_owner"] },
        },
      };
    }
    const rows = db.prepare(`
      SELECT id, period_start, period_end, status, source_refs, created_at, updated_at
      FROM weekly_reports
      WHERE owner = $owner
        AND deleted_at IS NULL
        AND status IN ('draft', 'saved', 'ready')
        AND period_start <= date($weekStart, '+6 days')
        AND period_end >= $weekStart
      ORDER BY period_start DESC, updated_at DESC, id
      LIMIT ${MAX_ITEMS + 1}
    `).all({ $owner: normalizedOwner, $weekStart: normalizedWeek });
    const items = rows.slice(0, MAX_ITEMS).map((row) => {
      const sourceRefs = boundedSourceRefs(row.source_refs);
      return {
        id: row.id,
        periodStart: row.period_start,
        periodEnd: row.period_end,
        status: WEEKLY_REPORT_STATUSES.has(row.status) ? row.status : null,
        sourceRefs,
        sourceRefCount: sourceRefs.length,
        createdAt: trustedDatabaseTimestamp(row.created_at),
        updatedAt: trustedDatabaseTimestamp(row.updated_at),
      };
    });
    const statusCounts = { draft: 0, saved: 0, ready: 0 };
    for (const item of items) if (item.status) statusCounts[item.status] += 1;
    const truncated = rows.length > MAX_ITEMS;
    const blockers = [];
    if (items.length === 0) blockers.push("no_weekly_report");
    if (truncated) blockers.push("truncated");

    const sourceRows = db.prepare(`
      SELECT qr.id, qr.occurred_at, qr.source_channel, ai.analysis_json
      FROM quick_records qr
      LEFT JOIN ai_insights ai ON ai.id = (
        SELECT latest.id
        FROM ai_insights latest
        WHERE latest.quick_record_id = qr.id
        ORDER BY latest.created_at DESC, latest.id DESC
        LIMIT 1
      )
      WHERE qr.owner = $owner
        AND qr.voided_at IS NULL
        AND qr.status = 'analyzed'
        AND date(substr(COALESCE(qr.occurred_at, qr.created_at), 1, 10))
          BETWEEN $weekStart AND date($weekStart, '+6 days')
        AND (
          qr.source_channel = '微信助手'
          OR EXISTS (
            SELECT 1
            FROM manual_confirmations confirmation
            WHERE confirmation.quick_record_id = qr.id
              AND confirmation.target = 'weekly'
          )
        )
      ORDER BY COALESCE(qr.occurred_at, qr.created_at), qr.id
      LIMIT ${MAX_ITEMS + 1}
    `).all({ $owner: normalizedOwner, $weekStart: normalizedWeek });
    const sourceRecords = sourceRows.slice(0, MAX_ITEMS).map((row) => ({
      id: row.id,
      occurredAt: row.occurred_at,
      sourceChannel: optionalText(row.source_channel, 100),
      analysis: boundedAnalysis(parseJsonObject(row.analysis_json)),
    }));
    const sourceTruncated = sourceRows.length > MAX_ITEMS;
    const previewEndDate = new Date(`${normalizedWeek}T00:00:00.000Z`);
    previewEndDate.setUTCDate(previewEndDate.getUTCDate() + 6);
    const draft = buildWeeklyDraft({
      owner: normalizedOwner,
      periodStart: normalizedWeek,
      periodEnd: formatDateOnlyUtc(previewEndDate),
      records: sourceRecords,
      knowledge: [],
    });
    const previewRefs = draft.sourceRefs.slice(0, MAX_ITEMS).flatMap((item) => {
      const type = optionalText(item?.type, 80);
      const id = optionalText(item?.id, 200);
      return type && id ? [{ type, id }] : [];
    });
    const previewBlockers = [];
    if (sourceRecords.length === 0) previewBlockers.push("no_confirmed_records");
    if (sourceTruncated) previewBlockers.push("truncated");
    return {
      weekStart: normalizedWeek,
      reportCount: items.length,
      statusCounts,
      items,
      truncated,
      partial: truncated,
      preparation: { ready: blockers.length === 0, blockers },
      preview: {
        persisted: false,
        sourceRecordCount: sourceRecords.length,
        content: draft.content.slice(0, 20_000),
        sourceRefs: previewRefs,
        truncated: sourceTruncated,
        preparation: { ready: previewBlockers.length === 0, blockers: previewBlockers },
      },
    };
  }

  function knowledgeSearch({ query }) {
    const pattern = likePattern(query);
    const items = db.prepare(`
      SELECT id, title, category, summary, source, updated_at
      FROM knowledge_items
      WHERE deleted_at IS NULL
        AND (title LIKE $pattern ESCAPE '\\' OR category LIKE $pattern ESCAPE '\\' OR summary LIKE $pattern ESCAPE '\\')
      ORDER BY updated_at DESC, title, id
      LIMIT 10
    `).all({ $pattern: pattern }).map((row) => ({
      id: row.id,
      title: optionalText(row.title, 200),
      category: optionalText(row.category, 100),
      summary: optionalText(row.summary, 500),
      source: optionalText(row.source, 200),
      updatedAt: trustedDatabaseTimestamp(row.updated_at),
    }));
    return { items };
  }

  return Object.freeze({
    dashboardSummary,
    customerSearch,
    customerDetail,
    opportunitySearch,
    opportunityDetail,
    projectAnalysis,
    actionRiskSummary,
    itinerarySummary,
    travelExpenseSummary,
    salesReportSummary,
    knowledgeSearch,
  });
}
