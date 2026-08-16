import {
  NOTICE_FIELD_LIMITS,
  normalizeNoticeSnapshot,
  normalizeNoticeMatch,
} from "./repository.js";

const CUSTOMER_ARRAY_FIELDS = ["aliases", "hospitalNames", "needs", "requirements", "painPoints", "tags", "keywords"];

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function requiredText(value, name, max) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw new TypeError(`${name} is too long`);
  return normalized;
}

function boundedStrings(value, name, maxItems, itemMax) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  if (value.length > maxItems) throw new TypeError(`${name} contains too many items`);
  const result = [];
  const seen = new Set();
  value.forEach((item, index) => {
    const normalized = requiredText(item, `${name}[${index}]`, itemMax);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  });
  return result;
}

function optionalText(value, name, max) {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, name, max);
}

function customerSnapshot(input, index) {
  if (!isPlainObject(input)) throw new TypeError(`customer[${index}] must be an object`);
  const id = requiredText(input.id, `customer[${index}].id`, NOTICE_FIELD_LIMITS.customerId);
  const name = optionalText(input.name ?? input.customerName ?? input.hospitalName, `customer[${index}].name`, NOTICE_FIELD_LIMITS.sourceName);
  const city = optionalText(input.city, `customer[${index}].city`, NOTICE_FIELD_LIMITS.city);
  const arrays = {};
  for (const field of CUSTOMER_ARRAY_FIELDS) {
    arrays[field] = boundedStrings(
      input[field],
      `customer[${index}].${field}`,
      field === "needs" || field === "requirements" || field === "painPoints" ? 50 : 30,
      field === "needs" || field === "requirements" || field === "painPoints"
        ? NOTICE_FIELD_LIMITS.matchedNeeds
        : NOTICE_FIELD_LIMITS.matchReason,
    );
  }
  return { id, name, city, ...arrays };
}

function searchText(notice) {
  return [
    notice.city,
    notice.title,
    notice.purchaser,
    notice.projectCode,
    notice.budgetText,
    notice.deadlineText,
    notice.contentText,
    ...notice.hospitalNames,
  ].filter(Boolean).join(" ").toLocaleLowerCase();
}

function contains(text, value) {
  return Boolean(value) && text.includes(value.toLocaleLowerCase());
}

/**
 * Match a notice to caller-supplied, already de-identified customer snapshots.
 * The function deliberately has no repository, network, model, or secret
 * access and only returns a proposal; it never creates/updates CRM records.
 */
export function matchNoticeToCustomers(inputNotice, customers = []) {
  if (!isPlainObject(inputNotice)) throw new TypeError("notice must be an object");
  // Repository reads include a persisted match sidecar and timestamps. Those
  // are ignored here; only the bounded notice snapshot is eligible evidence.
  const noticeInput = { ...inputNotice };
  delete noticeInput.match;
  delete noticeInput.firstSeenAt;
  delete noticeInput.lastSeenAt;
  const notice = normalizeNoticeSnapshot(noticeInput);
  if (!Array.isArray(customers)) throw new TypeError("customers must be an array");
  if (customers.length > 200) throw new TypeError("customers contains too many items");
  const text = searchText(notice);
  const matchedCustomerIds = [];
  const matchReasons = {};
  const matchedNeeds = {};
  let matchScore = 0;

  const seenCustomerIds = new Set();
  customers.forEach((rawCustomer, index) => {
    const customer = customerSnapshot(rawCustomer, index);
    if (seenCustomerIds.has(customer.id)) throw new TypeError(`customer[${index}].id is duplicated`);
    seenCustomerIds.add(customer.id);
    const names = [customer.name, ...customer.aliases, ...customer.hospitalNames].filter(Boolean);
    const nameHit = names.some((name) => contains(text, name));
    const cityHit = Boolean(customer.city && contains(text, customer.city));
    const needs = [...customer.needs, ...customer.requirements, ...customer.painPoints];
    const needHits = needs.filter((need) => contains(text, need));
    const keywords = [...customer.tags, ...customer.keywords];
    const keywordHit = keywords.some((keyword) => contains(text, keyword));

    // Identity evidence is required unless both city and a concrete need agree.
    if (!nameHit && !(cityHit && needHits.length > 0)) return;

    const reasons = [];
    if (nameHit) reasons.push("hospital_name");
    if (cityHit) reasons.push("city");
    if (needHits.length > 0) reasons.push("need");
    if (keywordHit) reasons.push("keyword");
    matchedCustomerIds.push(customer.id);
    matchReasons[customer.id] = reasons;
    matchedNeeds[customer.id] = needHits;

    let score = 0;
    if (nameHit) score += 60;
    if (cityHit) score += 15;
    if (needHits.length > 0) score += 25;
    else if (keywordHit) score += 10;
    matchScore = Math.max(matchScore, Math.min(100, score));
  });

  return normalizeNoticeMatch({ matchedCustomerIds, matchReasons, matchedNeeds, matchScore });
}
