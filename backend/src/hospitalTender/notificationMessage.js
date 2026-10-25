import { canonicalNoticeIdentityCandidates } from "./canonicalBridge.js";

const PUBLIC_RESOURCE_SOURCE = /公共资源|公共交易|公共服务平台|政府采购|公共采购|公开采购|采购平台|公共平台|交易中心|交易平台/u;
const BUDGET_LABEL = /(?:项目预算金额|预算金额|采购预算(?:金额)?|项目预算|最高投标限价|最高限价|招标控制价|预算)/u;
const MONEY = /(?:人民币\s*)?([¥￥]?\s*\d[\d,]*(?:\.\d+)?)\s*(亿元|万元|千元|元|万|亿)?/u;
const MONEY_ONLY = /^\s*(?:人民币\s*)?([¥￥]?\s*\d[\d,]*(?:\.\d+)?)\s*(亿元|万元|千元|元|万|亿)?\s*$/u;

function safeText(value, max = 500) {
  return String(value ?? "")
    .replace(/<[^>]*>/gu, " ")
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim()
    .slice(0, max);
}

function safeHttpUrl(value) {
  const raw = safeText(value, 2_000);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return "";
    return parsed.href;
  } catch {
    return "";
  }
}

function publicSourceScore(source) {
  const sourceId = safeText(source?.sourceId ?? source?.source_id, 200).toLocaleLowerCase();
  const sourceName = safeText(source?.sourceName ?? source?.source_name, 200);
  if (PUBLIC_RESOURCE_SOURCE.test(sourceName) || /(?:^|[-_])ggzy(?:$|[-_])/u.test(sourceId)) return 2;
  return 0;
}

function candidateSet(notice) {
  try {
    return new Set(canonicalNoticeIdentityCandidates(notice));
  } catch {
    return new Set();
  }
}

function sharesCandidate(left, right) {
  for (const candidate of left) if (right.has(candidate)) return true;
  return false;
}

function formatMoney(value, unitHint = "") {
  const match = MONEY.exec(value);
  if (!match) return "";
  const amount = match[1].replace(/\s+/gu, "");
  return `${amount}${match[2] || unitHint}`;
}

export function extractTenderBudget(notice = {}) {
  const explicit = safeText(notice?.budgetText ?? notice?.budget_text, 300);
  if (explicit) {
    const labeled = extractLabeledBudget(explicit);
    if (labeled) return labeled;
    const amount = MONEY_ONLY.exec(explicit);
    return amount ? `${amount[1].replace(/\s+/gu, "")}${amount[2] ?? ""}` : "";
  }
  return extractLabeledBudget(notice?.contentText ?? notice?.content_text ?? "");
}

function extractLabeledBudget(value) {
  const text = String(value ?? "")
    .replace(/<br\s*\/?>|<\/(?:p|div|tr|li|h[1-6])\s*>/giu, "\n")
    .replace(/<[^>]*>/gu, " ");
  const lines = text.split(/[\r\n]+/u).map((line) => line.replace(/\s+/gu, " ").trim());
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const label = BUDGET_LABEL.exec(line);
    if (!label) continue;
    const suffix = line.slice(label.index + label[0].length);
    const unitHint = /[（(][^）)]*(亿元|万元|千元|元|万|亿)[^）)]*[）)]/u.exec(suffix)?.[1] ?? "";
    const amount = MONEY.exec(suffix);
    const safePrefix = amount && /^[\s:：=，,（()）)约为人民币暂估不超过预计最高万元亿元千元元万亿]*$/u.test(
      suffix.slice(0, amount.index),
    );
    if (amount && safePrefix) return formatMoney(amount[0], unitHint);
    const nextLine = MONEY_ONLY.exec(lines[index + 1] ?? "");
    if (nextLine) {
      const valueText = nextLine[1].replace(/\s+/gu, "");
      return `${valueText}${nextLine[2] || unitHint}`;
    }
  }
  return "";
}

function formatPublishedAt(value) {
  const raw = safeText(value, 64);
  if (!raw) return "时间待公告";
  const timestamp = Date.parse(raw);
  if (Number.isNaN(timestamp)) return raw;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(timestamp);
  const field = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${field.year}-${field.month}-${field.day} ${field.hour}:${field.minute}`;
}

function markdownText(value) {
  return safeText(value, 600).replace(/[\\`*_{}\[\]()|<>]/gu, "\\$&") || "未提供";
}

function linkLabel(source) {
  if (publicSourceScore(source) > 0) return "查看公共资源交易平台公告";
  const name = safeText(source?.sourceName ?? source?.source_name, 200);
  return /医院/u.test(name) ? "查看医院官网公告" : "查看公告原文";
}

/** Select one push row per canonical notice and attach its best available source link. */
export function prepareHospitalTenderPushplusNotices({ notices = [], sourceNotices = [], customers = [] } = {}) {
  if (!Array.isArray(notices) || !Array.isArray(sourceNotices)) return [];
  const unique = new Map();
  for (const notice of notices) {
    const candidates = candidateSet(notice);
    const key = safeText(notice?.canonicalNoticeId, 500)
      || safeText(notice?.identityKey, 500)
      || safeText(notice?.id, 500);
    if (!key) continue;
    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, { notice: { ...notice }, candidates });
      continue;
    }
    const ids = new Set([
      ...(existing.notice.match?.matchedCustomerIds ?? []),
      ...(notice.match?.matchedCustomerIds ?? []),
    ]);
    existing.notice = {
      ...existing.notice,
      match: {
        ...(existing.notice.match ?? {}),
        matchedCustomerIds: [...ids],
      },
    };
    for (const candidate of candidates) existing.candidates.add(candidate);
  }

  const customerNames = new Map(customers
    .filter((customer) => customer && customer.id && customer.name)
    .map((customer) => [String(customer.id), safeText(customer.name, 200)]));

  return [...unique.values()].map(({ notice, candidates }) => {
    const matchingSources = sourceNotices.filter((source) => sharesCandidate(candidates, candidateSet(source)));
    const sources = matchingSources.length > 0 ? matchingSources : [notice];
    sources.sort((left, right) => publicSourceScore(right) - publicSourceScore(left));
    const preferred = sources[0];
    const budgetText = sources.map((source) => extractTenderBudget(source)).find(Boolean)
      || extractTenderBudget(notice)
      || "公告未披露";
    const matchedCustomerIds = notice.match?.matchedCustomerIds ?? [];
    const matchedCustomerNames = [...new Set(matchedCustomerIds
      .map((id) => customerNames.get(String(id)))
      .filter(Boolean))];
    const selectedUrl = safeHttpUrl(preferred?.url) || safeHttpUrl(notice.url);

    return {
      ...notice,
      title: safeText(preferred?.title, 600) || notice.title,
      sourceName: safeText(preferred?.sourceName ?? preferred?.source_name, 200) || notice.sourceName,
      url: selectedUrl,
      publishedAt: preferred?.publishedAt ?? preferred?.published_at ?? notice.publishedAt,
      budgetText,
      matchedCustomerNames,
    };
  });
}

/** Markdown PushPlus detail block, intentionally concise and field-aligned. */
export function hospitalTenderPushplusNoticeLine(notice) {
  const customer = Array.isArray(notice?.matchedCustomerNames) && notice.matchedCustomerNames.length > 0
    ? notice.matchedCustomerNames.map((name) => markdownText(name)).join("、")
    : "客户待确认";
  const title = markdownText(notice?.title ?? "未命名公告");
  const budget = markdownText(extractTenderBudget(notice) || "公告未披露");
  const published = markdownText(formatPublishedAt(notice?.publishedAt ?? notice?.published_at));
  const url = safeHttpUrl(notice?.url);
  const source = linkLabel(notice);
  return [
    `**客户名称：** ${customer}`,
    `**项目名称：** ${title}`,
    `**预算金额：** ${budget}`,
    `**时间：** ${published}`,
    url ? `[${source}](${url})` : "公告链接待补充",
  ].join("\n");
}
