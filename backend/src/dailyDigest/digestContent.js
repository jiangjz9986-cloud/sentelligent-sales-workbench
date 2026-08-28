import { weixinClip } from "../assistant/weixinCard.js";

// Deterministic content assembly for the daily digest (v0.7.7). Every query is
// owner-scoped through the same closed business-owner mapping the tender
// notifier uses; payloads carry pre-rendered lines only, so no outbox
// forbidden key (owner/source/account/...) ever enters the payload.

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;
const OPEN_TODO_STATUSES = Object.freeze(["pending", "in_progress"]);
const CATEGORY_LABELS = Object.freeze({
  breakfast: "早餐",
  lunch: "午餐",
  dinner: "晚餐",
  lodging: "住宿",
  transport: "交通",
  hospitality: "招待",
  other: "其他",
});

const DAILY_FOOTER = "回复“完成待办 <编号>”处理待办；发送“行程”/“动作风险”查看详情，招标请看系统招标监测页。";
const FRIDAY_FOOTER = "补传凭证/发票请在系统差旅页操作；发送“报销周报”查看本周报销全景。";

// China has no daylight saving, so a fixed +8 shift plus UTC accessors is
// exactly equivalent to the Intl Asia/Shanghai formatting used elsewhere.
export function shanghaiDateParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("a valid instant is required");
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  return {
    date: shifted.toISOString().slice(0, 10),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

export function addDays(dateOnly, days) {
  if (typeof dateOnly !== "string" || !DATE_ONLY.test(dateOnly)) throw new TypeError("dateOnly is invalid");
  if (!Number.isSafeInteger(days)) throw new TypeError("days must be an integer");
  const date = new Date(`${dateOnly}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new TypeError("dateOnly is invalid");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function weekStartOf(dateOnly) {
  if (typeof dateOnly !== "string" || !DATE_ONLY.test(dateOnly)) throw new TypeError("dateOnly is invalid");
  const date = new Date(`${dateOnly}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new TypeError("dateOnly is invalid");
  const shift = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - shift);
  return date.toISOString().slice(0, 10);
}

export function fridayOfWeek(dateOnly) {
  return addDays(weekStartOf(dateOnly), 4);
}

function shanghaiClockOf(instantIso) {
  const parsed = new Date(instantIso);
  if (Number.isNaN(parsed.getTime())) return null;
  const parts = shanghaiDateParts(parsed);
  const time = `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
  return { date: parts.date, monthDay: parts.date.slice(5), time };
}

function formatMoney(cents) {
  return Number.isSafeInteger(cents) && cents >= 0 ? `${(cents / 100).toFixed(2)} 元` : "待确认";
}

function idSuffixOf(id) {
  const text = String(id ?? "").trim();
  return text.length > 6 ? text.slice(-6) : text;
}

function countLabel(count, truncated) {
  return truncated ? `${count}+` : `${count}`;
}

function daysBetween(fromDateOnly, toDateOnly) {
  const from = Date.parse(`${fromDateOnly}T00:00:00.000Z`);
  const to = Date.parse(`${toDateOnly}T00:00:00.000Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}

export function createDigestContentBuilder({
  db,
  snapshotAdapter,
  actionItemStore,
  tenderRepository,
  resolveBusinessOwner,
  clock = () => new Date(),
  dailyTime = { hour: 9, minute: 0 },
} = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A synchronous SQLite connection is required");
  if (!snapshotAdapter || typeof snapshotAdapter.actionRiskSummary !== "function"
    || typeof snapshotAdapter.travelExpenseSummary !== "function"
    || typeof snapshotAdapter.salesReportSummary !== "function") {
    throw new TypeError("snapshotAdapter with actionRiskSummary/travelExpenseSummary/salesReportSummary is required");
  }
  if (!actionItemStore || typeof actionItemStore.list !== "function") throw new TypeError("actionItemStore is required");
  if (!tenderRepository || typeof tenderRepository.listNotices !== "function" || typeof tenderRepository.countNotices !== "function") {
    throw new TypeError("tenderRepository with listNotices/countNotices is required");
  }
  if (typeof resolveBusinessOwner !== "function") throw new TypeError("resolveBusinessOwner must be a function");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  if (!dailyTime || !Number.isSafeInteger(dailyTime.hour) || dailyTime.hour < 0 || dailyTime.hour > 23
    || !Number.isSafeInteger(dailyTime.minute) || dailyTime.minute < 0 || dailyTime.minute > 59) {
    throw new TypeError("dailyTime is invalid");
  }

  const itineraryTodayStatement = db.prepare(`
    SELECT id, title, plan_json
    FROM visit_itineraries
    WHERE created_by = $owner AND deleted_at IS NULL AND status = 'planned' AND visit_date = $today
    ORDER BY updated_at DESC, id
    LIMIT 4
  `);

  // Same three-branch visibility as actionItemStore/actionRows: own owner
  // column, or ownership derived through the linked opportunity or customer.
  const unscheduledTodoCountStatement = db.prepare(`
    SELECT COUNT(*) AS count
    FROM action_items action
    LEFT JOIN opportunities opportunity ON opportunity.id = action.opportunity_id AND opportunity.deleted_at IS NULL
    LEFT JOIN customers action_customer ON action_customer.id = action.customer_id AND action_customer.deleted_at IS NULL
    LEFT JOIN customers opportunity_customer ON opportunity_customer.id = opportunity.customer_id AND opportunity_customer.deleted_at IS NULL
    WHERE action.deleted_at IS NULL
      AND action.remind_at IS NULL
      AND action.status IN ('pending', 'in_progress')
      AND (
        action.owner = $owner
        OR (action.opportunity_id IS NOT NULL
          AND (action.customer_id IS NULL OR action.customer_id = opportunity.customer_id)
          AND (opportunity.owner = $owner OR (opportunity.owner IS NULL AND opportunity_customer.owner = $owner)))
        OR (action.opportunity_id IS NULL AND action.customer_id IS NOT NULL AND action_customer.owner = $owner)
      )
  `);

  // Mirrors the web ledger's paymentProofMissingCount rule: an expense is
  // "proof missing" when it has no payment_proof attachment at all.
  const proofMissingListStatement = db.prepare(`
    SELECT expense.id, expense.occurred_on, expense.category, expense.purpose
    FROM travel_expenses expense
    WHERE expense.owner = $owner AND expense.deleted_at IS NULL
      AND expense.occurred_on BETWEEN $weekStart AND date($weekStart, '+6 days')
      AND NOT EXISTS (
        SELECT 1 FROM travel_expense_attachments attachment
        WHERE attachment.expense_id = expense.id AND attachment.kind = 'payment_proof'
      )
    ORDER BY expense.occurred_on, expense.id
    LIMIT 9
  `);
  const proofMissingCountStatement = db.prepare(`
    SELECT COUNT(*) AS count
    FROM travel_expenses expense
    WHERE expense.owner = $owner AND expense.deleted_at IS NULL
      AND expense.occurred_on BETWEEN $weekStart AND date($weekStart, '+6 days')
      AND NOT EXISTS (
        SELECT 1 FROM travel_expense_attachments attachment
        WHERE attachment.expense_id = expense.id AND attachment.kind = 'payment_proof'
      )
  `);

  function resolvedOwnerOf(owner) {
    const resolved = resolveBusinessOwner(typeof owner === "string" ? owner.trim() : "");
    return typeof resolved === "string" && resolved.trim() ? resolved.trim() : null;
  }

  function itinerarySection(owner, today) {
    const rows = itineraryTodayStatement.all({ $owner: owner, $today: today });
    const shown = rows.slice(0, 3).map((row) => {
      const title = weixinClip(row.title, 30, "未命名行程");
      let stopCount = null;
      let firstStop = null;
      try {
        const plan = JSON.parse(row.plan_json);
        const stops = Array.isArray(plan?.stops) && plan.stops.length > 0 ? plan.stops : null;
        if (stops) {
          const orderedIds = Array.isArray(plan?.orderedStopIds) ? plan.orderedStopIds : [];
          const first = stops.find((stop) => stop?.id === orderedIds[0]) ?? stops[0];
          stopCount = stops.length;
          firstStop = typeof first?.customerName === "string" && first.customerName.trim()
            ? weixinClip(first.customerName, 30, "")
            : null;
        }
      } catch {
        // Fail open on a corrupted plan snapshot: the row still shows its title.
      }
      return { title, stopCount, firstStop };
    });
    const totalStops = shown.reduce((sum, item) => sum + (item.stopCount ?? 0), 0);
    const lines = shown.map((item) => {
      if (item.stopCount === null) return `· ${item.title}`;
      const first = item.firstStop ? ` ｜ 首站 ${item.firstStop}` : "";
      return `· ${item.title} ｜ ${item.stopCount} 站${first}`;
    });
    return {
      lines,
      itineraryCount: shown.length,
      totalStops,
      firstStop: shown.find((item) => item.firstStop)?.firstStop ?? null,
    };
  }

  function todoSection(owner, today) {
    const overdue = actionItemStore.list({
      owner,
      dateEnd: addDays(today, -1),
      statuses: OPEN_TODO_STATUSES,
      limit: 50,
    });
    const dueToday = actionItemStore.list({
      owner,
      dateStart: today,
      dateEnd: today,
      statuses: OPEN_TODO_STATUSES,
      limit: 50,
    });
    const unscheduledRow = unscheduledTodoCountStatement.get({ $owner: owner });
    const unscheduledCount = Number(unscheduledRow?.count ?? 0);
    const overdueShown = overdue.items.slice(0, 5);
    const todayShown = dueToday.items.slice(0, 5);
    const lines = [];
    if (overdueShown.length > 0) {
      lines.push("逾期：");
      for (const item of overdueShown) {
        const at = shanghaiClockOf(item.remindAt);
        const when = at ? `${at.monthDay} ${at.time}` : "时间待确认";
        lines.push(`· [${item.priority ?? "中"}] ${weixinClip(item.title, 20, "未命名待办")} ｜ ${when} ｜ ${idSuffixOf(item.id)}`);
      }
    }
    if (todayShown.length > 0) {
      lines.push("今日：");
      for (const item of todayShown) {
        const at = shanghaiClockOf(item.remindAt);
        lines.push(`· [${item.priority ?? "中"}] ${weixinClip(item.title, 20, "未命名待办")} ｜ ${at ? at.time : "时间待确认"} ｜ ${idSuffixOf(item.id)}`);
      }
    }
    if (lines.length > 0 && unscheduledCount > 0) {
      lines.push(`另有未排期待办 ${unscheduledCount} 条。`);
    }
    return {
      lines,
      overdueCount: overdue.items.length,
      overdueLabel: countLabel(overdue.items.length, overdue.truncated),
      todayCount: dueToday.items.length,
      todayLabel: countLabel(dueToday.items.length, dueToday.truncated),
      unscheduledCount,
      topOverdueHigh: overdueShown.find((item) => item.priority === "高") ?? null,
    };
  }

  function riskSection(owner) {
    const summary = snapshotAdapter.actionRiskSummary({ owner });
    const risks = { items: summary.risks, truncated: summary.truncated?.risks === true };
    const activeCount = risks.items.length;
    const highRisks = risks.items.filter((item) => item.severity === "高" || (item.score ?? 0) >= 80).slice(0, 3);
    const lines = highRisks.map((item) => {
      const score = item.score === null || item.score === undefined ? "" : `·${item.score}分`;
      const due = item.due ? ` ｜ 截止 ${weixinClip(item.due, 20, "")}` : "";
      return `· [${item.severity ?? "中"}${score}] ${weixinClip(item.title, 20, "未命名风险")}${due}`;
    });
    if (lines.length === 0 && activeCount > 0) {
      lines.push(`活跃风险 ${countLabel(activeCount, risks.truncated)} 条，无高危。`);
    }
    return {
      lines,
      activeCount,
      activeLabel: countLabel(activeCount, risks.truncated),
      highCount: highRisks.length,
      topRisk: risks.items.find((item) => (item.score ?? 0) >= 80) ?? null,
    };
  }

  function tenderSection(today) {
    const anchorIso = new Date(
      Date.parse(`${addDays(today, -1)}T00:00:00.000Z`)
      + ((dailyTime.hour * 60 + dailyTime.minute) * 60 * 1000)
      - SHANGHAI_OFFSET_MS,
    ).toISOString();
    const highNotices = tenderRepository.listNotices({ firstSeenFrom: anchorIso, relevance: "high", limit: 6 });
    const highCount = tenderRepository.countNotices({ firstSeenFrom: anchorIso, relevance: "high" });
    const mediumCount = tenderRepository.countNotices({ firstSeenFrom: anchorIso, relevance: "medium" });
    const shown = highNotices.slice(0, 5);
    const lines = shown.map((notice) => {
      const source = weixinClip(notice.sourceName, 20, "公开来源");
      const deadline = notice.deadlineText ? ` ｜ 截止 ${weixinClip(notice.deadlineText, 20, "")}` : "";
      return `· ${weixinClip(notice.title, 60, "未命名公告")} ｜ ${source}${deadline}`;
    });
    if (highCount > shown.length) {
      lines.push(`另有 ${highCount - shown.length} 条高相关见系统招标页。`);
    }
    if (highCount === 0 && mediumCount > 0) {
      lines.push(`中相关新公告 ${mediumCount} 条（未匹配重点客户）。`);
    }
    return { lines, highCount, mediumCount, latestHigh: shown[0] ?? null, anchorIso };
  }

  function headlineOf({ today, todos, itinerary, risks, tenders }) {
    if (todos.topOverdueHigh) {
      const at = shanghaiClockOf(todos.topOverdueHigh.remindAt);
      const overdueDays = at ? Math.max(1, daysBetween(at.date, today) ?? 1) : 1;
      return `焦点：逾期待办「${weixinClip(todos.topOverdueHigh.title, 20, "未命名待办")}」已过期 ${overdueDays} 天，建议今天处理。`;
    }
    if (itinerary.itineraryCount > 0) {
      return itinerary.firstStop
        ? `焦点：今天有 ${itinerary.totalStops} 站拜访，首站 ${itinerary.firstStop}。`
        : `焦点：今天有 ${itinerary.itineraryCount} 条拜访行程。`;
    }
    if (risks.topRisk) {
      return `焦点：风险「${weixinClip(risks.topRisk.title, 20, "未命名风险")}」（${risks.topRisk.score} 分）待处理。`;
    }
    if (tenders.latestHigh) {
      return `焦点：新招标「${weixinClip(tenders.latestHigh.title, 30, "未命名公告")}」值得关注。`;
    }
    return null;
  }

  function buildDailyDigest({ owner, now = clock() } = {}) {
    const businessOwner = resolvedOwnerOf(owner);
    if (!businessOwner) return { empty: true, reason: "no_business_owner" };
    const today = shanghaiDateParts(now).date;

    const itinerary = itinerarySection(businessOwner, today);
    const todos = todoSection(businessOwner, today);
    const risks = riskSection(businessOwner);
    const tenders = tenderSection(today);

    const sections = [];
    if (itinerary.lines.length > 0) {
      sections.push({ heading: `今日行程（${itinerary.totalStops} 站）`, lines: itinerary.lines });
    }
    if (todos.lines.length > 0) {
      sections.push({ heading: `待办（逾期 ${todos.overdueLabel} ｜ 今日 ${todos.todayLabel}）`, lines: todos.lines });
    }
    if (risks.lines.length > 0) {
      sections.push({ heading: `活跃风险（共 ${risks.activeLabel} 条，高危 ${risks.highCount}）`, lines: risks.lines });
    }
    if (tenders.lines.length > 0) {
      sections.push({ heading: `新招标（昨日以来 高相关 ${tenders.highCount} 条）`, lines: tenders.lines });
    }
    if (sections.length === 0) return { empty: true, reason: "empty" };

    const payload = {
      kind: "daily_digest",
      digestDate: today,
      headline: headlineOf({ today, todos, itinerary, risks, tenders }),
      sections,
      footer: DAILY_FOOTER,
    };
    return {
      empty: false,
      payload,
      stats: {
        itineraryCount: itinerary.itineraryCount,
        stopCount: itinerary.totalStops,
        overdueCount: todos.overdueCount,
        todayTodoCount: todos.todayCount,
        unscheduledTodoCount: todos.unscheduledCount,
        activeRiskCount: risks.activeCount,
        highRiskCount: risks.highCount,
        tenderHighCount: tenders.highCount,
        tenderMediumCount: tenders.mediumCount,
      },
    };
  }

  function reportLineOf(report) {
    const statusLabels = { draft: "草稿", saved: "已保存", ready: "就绪" };
    if (report.reportCount > 0) {
      const latest = statusLabels[report.items[0]?.status] ?? "草稿";
      return `本周已有周报 ${report.reportCount} 份（最新：${latest}）。发送“销售周报”可查看预览。`;
    }
    const sourceCount = report.preview?.sourceRecordCount ?? 0;
    if (sourceCount > 0) {
      return `本周还没有周报。已确认素材 ${sourceCount} 条，Web 周报页可一键生成草稿，或发送“销售周报”先看预览。`;
    }
    return "本周暂无已确认的周报素材——快速记录确认后会自动进入周报。";
  }

  function buildFridayCloseout({ owner, now = clock() } = {}) {
    const businessOwner = resolvedOwnerOf(owner);
    if (!businessOwner) return { empty: true, reason: "no_business_owner" };
    const today = shanghaiDateParts(now).date;
    const weekStart = weekStartOf(today);

    const report = snapshotAdapter.salesReportSummary({ owner: businessOwner, weekStart });
    const expenses = snapshotAdapter.travelExpenseSummary({ owner: businessOwner, weekStart });
    const invoiceMissing = expenses.items.filter((item) => (item.unacknowledgedMissingCents ?? 0) > 0);
    const invoiceShown = invoiceMissing.slice(0, 8);
    const invoiceLines = invoiceShown.map((item) => {
      const category = CATEGORY_LABELS[item.category] ?? weixinClip(item.category, 8, "其他");
      const purpose = item.purpose ? ` ${weixinClip(item.purpose, 16, "")}` : "";
      return `· ${String(item.occurredOn ?? "").slice(5)} ${category}${purpose} ｜ 可报销 ${formatMoney(item.reimbursementCents)} ｜ 缺票 ${formatMoney(item.unacknowledgedMissingCents)}`;
    });
    if (invoiceMissing.length > invoiceShown.length) {
      invoiceLines.push(`另有 ${invoiceMissing.length - invoiceShown.length} 笔请在差旅页处理。`);
    }

    const proofRows = proofMissingListStatement.all({ $owner: businessOwner, $weekStart: weekStart });
    const proofCountRow = proofMissingCountStatement.get({ $owner: businessOwner, $weekStart: weekStart });
    const proofCount = Number(proofCountRow?.count ?? 0);
    const proofShown = proofRows.slice(0, 8);
    const proofLines = proofShown.map((row) => {
      const category = CATEGORY_LABELS[row.category] ?? weixinClip(row.category, 8, "其他");
      const purpose = row.purpose ? ` ${weixinClip(row.purpose, 16, "")}` : "";
      return `· ${String(row.occurred_on ?? "").slice(5)} ${category}${purpose} ｜ 缺支付凭证`;
    });
    if (proofCount > proofShown.length) {
      proofLines.push(`另有 ${proofCount - proofShown.length} 笔请在差旅页处理。`);
    }

    const sections = [{ heading: "周报", lines: [reportLineOf(report)] }];
    if (proofLines.length === 0 && invoiceLines.length === 0) {
      sections.push({ heading: "凭证与发票", lines: ["本周凭证与发票已齐 ✓"] });
    } else {
      if (proofLines.length > 0) {
        sections.push({ heading: `凭证缺失（${proofCount} 笔）`, lines: proofLines });
      }
      if (invoiceLines.length > 0) {
        const total = expenses.summary?.unacknowledgedMissingCents;
        const totalLabel = Number.isSafeInteger(total) ? ` ｜ 合计 ${formatMoney(total)}` : "";
        sections.push({ heading: `发票缺失（${invoiceMissing.length} 笔${totalLabel}）`, lines: invoiceLines });
      }
    }

    const payload = {
      kind: "friday_closeout",
      digestDate: fridayOfWeek(today),
      weekStart,
      sections,
      footer: FRIDAY_FOOTER,
    };
    return {
      empty: false,
      payload,
      stats: {
        reportCount: report.reportCount,
        reportSourceCount: report.preview?.sourceRecordCount ?? 0,
        invoiceMissingCount: invoiceMissing.length,
        invoiceMissingCents: expenses.summary?.unacknowledgedMissingCents ?? null,
        proofMissingCount: proofCount,
      },
    };
  }

  return Object.freeze({ buildDailyDigest, buildFridayCloseout });
}
