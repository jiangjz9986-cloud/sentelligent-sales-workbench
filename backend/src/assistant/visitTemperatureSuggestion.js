import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

const SCHEMA_VERSION = "visit-temperature-suggestion-v1";
const MAX_ID = 200;
const MAX_TEXT = 2_000;
const MAX_FACTS = 50;
const MAX_INFERENCES = 12;
const MAX_BASIS_KEYS = 12;
const MAX_HISTORY = 50;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const IDENTIFIER = /^[\u4e00-\u9fffA-Za-z0-9_.:-]+$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const STORED_STATUSES = new Set(["pending", "confirmed", "cancelled"]);

export class VisitTemperatureSuggestionError extends Error {
  constructor(code, message, { status = 400, details = null } = {}) {
    super(message);
    this.name = "VisitTemperatureSuggestionError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function fail(code, message, options) {
  throw new VisitTemperatureSuggestionError(code, message, options);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value, name, max = MAX_TEXT) {
  if (typeof value !== "string" || !value.trim()) {
    fail("INVALID_INPUT", `${name} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(normalized)) {
    fail("INVALID_INPUT", `${name} is invalid`);
  }
  return normalized;
}

function optionalText(value, name, max = MAX_TEXT) {
  if (value === undefined || value === null || value === "") return null;
  return text(value, name, max);
}

function identifier(value, name) {
  const normalized = text(value, name, MAX_ID);
  if (!IDENTIFIER.test(normalized) || normalized.startsWith("synthetic:")) {
    fail("INVALID_INPUT", `${name} is invalid`);
  }
  return normalized;
}

function positiveInteger(value, name) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    fail("INVALID_INPUT", `${name} must be a positive integer`);
  }
  return normalized;
}

function relation(value, name) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > 100) {
    fail("INVALID_INPUT", `${name} must be an integer from 0 to 100`);
  }
  return normalized;
}

function confidence(value, name, fallback = null) {
  if ((value === undefined || value === null) && fallback !== null) return fallback;
  return relation(value, name);
}

function isoDate(value, name, { required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) fail("INVALID_INPUT", `${name} is required`);
    return null;
  }
  const normalized = typeof value === "string" || value instanceof Date ? new Date(value) : null;
  if (!normalized || Number.isNaN(normalized.getTime())) fail("INVALID_INPUT", `${name} must be a valid date-time`);
  return normalized.toISOString();
}

function clockDate(clock) {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("clock must return a valid Date");
  }
  return new Date(value);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function digest(value) {
  const encoded = JSON.stringify(canonicalValue(value));
  if (!encoded) throw new TypeError("digest input must be JSON serializable");
  return createHash("sha256").update(encoded, "utf8").digest("hex");
}

function sameDigest(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || !SHA256.test(left) || !SHA256.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function sourceRef(value, fallbackType = null, fallbackId = null) {
  const typeValue = value?.type ?? fallbackType;
  const idValue = value?.id ?? fallbackId;
  if (typeof typeValue !== "string" || typeof idValue !== "string") return null;
  try {
    return { type: identifier(typeValue, "sourceRef.type"), id: identifier(idValue, "sourceRef.id") };
  } catch (error) {
    if (error instanceof VisitTemperatureSuggestionError) return null;
    throw error;
  }
}

function uniqueSourceRefs(values) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const ref = sourceRef(value);
    if (!ref) continue;
    const key = `${ref.type}\u0000${ref.id}`;
    if (seen.has(key) || result.length >= MAX_FACTS) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

function evidenceValue(value, name) {
  if (typeof value === "string") return text(value, name, MAX_TEXT);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  fail("INVALID_INPUT", `${name} must be bounded text, a finite number, or a boolean`);
}

function normalizeEvidence(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FACTS) {
    fail("VISIT_EVIDENCE_REQUIRED", "A confirmed visit must contain bounded saved evidence", { status: 409 });
  }
  const keys = new Set();
  return value.map((raw, index) => {
    if (!isPlainObject(raw)) fail("INVALID_INPUT", `evidence[${index}] is invalid`);
    const key = identifier(raw.key, `evidence[${index}].key`);
    if (keys.has(key) || ["current_relation", "visit_occurred_at", "visit_confirmed_at"].includes(key)) {
      fail("INVALID_INPUT", `evidence[${index}].key is duplicated or reserved`);
    }
    keys.add(key);
    const ref = sourceRef(raw.sourceRef, raw.sourceType, raw.sourceId);
    if (!ref) fail("INVALID_INPUT", `evidence[${index}] requires a verified source reference`);
    return {
      key,
      label: optionalText(raw.label, `evidence[${index}].label`, 200) ?? key,
      value: evidenceValue(raw.value, `evidence[${index}].value`),
      confidence: confidence(raw.confidence, `evidence[${index}].confidence`, 100),
      sourceRefs: [ref],
    };
  });
}

function normalizeVisit(raw, { owner, visitId, requireEvidence = true } = {}) {
  if (!isPlainObject(raw) || raw.owner !== owner) return null;
  const id = identifier(raw.id, "visit.id");
  if (id !== visitId) return null;
  if (raw.status !== "confirmed"
    && !(raw.status === "analyzed" && raw.confirmationPreviewStatus === "completed")) {
    fail("VISIT_NOT_CONFIRMED", "The visit is not confirmed", { status: 409 });
  }
  const evidence = requireEvidence ? normalizeEvidence(raw.evidence) : [];
  return {
    id,
    owner,
    status: "confirmed",
    version: positiveInteger(raw.version, "visit.version"),
    customerId: identifier(raw.customerId, "visit.customerId"),
    occurredAt: isoDate(raw.occurredAt, "visit.occurredAt"),
    confirmedAt: isoDate(raw.confirmedAt, "visit.confirmedAt", { required: true }),
    evidence,
  };
}

function normalizeCustomer(raw, { owner, customerId } = {}) {
  if (!isPlainObject(raw) || raw.owner !== owner) return null;
  const id = identifier(raw.id, "customer.id");
  if (id !== customerId) return null;
  return {
    id,
    owner,
    version: positiveInteger(raw.version, "customer.version"),
    relation: relation(raw.relation, "customer.relation"),
    name: optionalText(raw.name, "customer.name", 300),
    updatedAt: isoDate(raw.updatedAt, "customer.updatedAt"),
  };
}

function factsFor(visit, customer) {
  const visitRef = { type: "quick_record", id: visit.id };
  const customerRef = { type: "customer", id: customer.id };
  return [
    {
      key: "current_relation",
      label: "当前客户温度",
      value: customer.relation,
      confidence: 100,
      sourceRefs: [customerRef],
    },
    ...(visit.occurredAt ? [{
      key: "visit_occurred_at",
      label: "拜访发生时间",
      value: visit.occurredAt,
      confidence: 100,
      sourceRefs: [visitRef],
    }] : []),
    {
      key: "visit_confirmed_at",
      label: "拜访确认时间",
      value: visit.confirmedAt,
      confidence: 100,
      sourceRefs: [visitRef],
    },
    ...visit.evidence.map((item) => clone(item)),
  ];
}

function visitSnapshot(visit) {
  return {
    id: visit.id,
    version: visit.version,
    customerId: visit.customerId,
    occurredAt: visit.occurredAt,
    confirmedAt: visit.confirmedAt,
    evidence: visit.evidence,
  };
}

function customerSnapshot(customer) {
  return {
    id: customer.id,
    version: customer.version,
    relation: customer.relation,
    name: customer.name,
    updatedAt: customer.updatedAt,
  };
}

function normalizeGenerated(raw, facts) {
  if (!isPlainObject(raw)) {
    fail("INVALID_GENERATED_SUGGESTION", "The suggestion generator returned an invalid result", { status: 502 });
  }
  let suggestedValue;
  let generatedConfidence;
  try {
    suggestedValue = relation(raw.suggestedValue, "generated.suggestedValue");
    generatedConfidence = confidence(raw.confidence, "generated.confidence");
  } catch (error) {
    if (error instanceof VisitTemperatureSuggestionError) {
      fail("INVALID_GENERATED_SUGGESTION", error.message, { status: 502 });
    }
    throw error;
  }
  if (!Array.isArray(raw.inferences) || raw.inferences.length === 0 || raw.inferences.length > MAX_INFERENCES) {
    fail("INVALID_GENERATED_SUGGESTION", "The generator must return bounded evidence-backed inferences", { status: 502 });
  }
  const factsByKey = new Map(facts.map((item) => [item.key, item]));
  const inferences = raw.inferences.map((item, index) => {
    if (!isPlainObject(item) || !Array.isArray(item.basisKeys) || item.basisKeys.length === 0 || item.basisKeys.length > MAX_BASIS_KEYS) {
      fail("INVALID_GENERATED_SUGGESTION", `generated.inferences[${index}] is invalid`, { status: 502 });
    }
    let claim;
    let itemConfidence;
    try {
      claim = text(item.claim, `generated.inferences[${index}].claim`, MAX_TEXT);
      itemConfidence = confidence(item.confidence, `generated.inferences[${index}].confidence`);
    } catch (error) {
      if (error instanceof VisitTemperatureSuggestionError) {
        fail("INVALID_GENERATED_SUGGESTION", error.message, { status: 502 });
      }
      throw error;
    }
    const basisKeys = [...new Set(item.basisKeys.map((key) => {
      try {
        return identifier(key, `generated.inferences[${index}].basisKey`);
      } catch (error) {
        if (error instanceof VisitTemperatureSuggestionError) {
          fail("INVALID_GENERATED_SUGGESTION", error.message, { status: 502 });
        }
        throw error;
      }
    }))];
    if (basisKeys.some((key) => !factsByKey.has(key))) {
      fail("INVALID_GENERATED_SUGGESTION", `generated.inferences[${index}] references unknown facts`, { status: 502 });
    }
    const basisFacts = basisKeys.map((key) => factsByKey.get(key));
    return {
      claim,
      basisKeys,
      basis: basisFacts.map((fact) => `${fact.label}：${String(fact.value)}`).join("；"),
      confidence: itemConfidence,
      sourceRefs: uniqueSourceRefs(basisFacts.flatMap((fact) => fact.sourceRefs)),
    };
  });
  return { suggestedValue, confidence: generatedConfidence, inferences };
}

function identityPayload(item) {
  return {
    schemaVersion: item.schemaVersion,
    id: item.id,
    owner: item.owner,
    visitId: item.visitId,
    visitEvidenceHash: item.visitEvidenceHash,
    customerId: item.customerId,
    customerVersion: item.customerVersion,
    previousValue: item.previousValue,
    suggestedValue: item.suggestedValue,
    inputSnapshotHash: item.inputSnapshotHash,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
  };
}

function normalizeStoredSuggestion(raw, { owner = null } = {}) {
  if (!isPlainObject(raw)) fail("SUGGESTION_DATA_INVALID", "Stored suggestion is invalid", { status: 500 });
  if (owner !== null && raw.owner !== owner) return null;
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    fail("SUGGESTION_DATA_INVALID", "Stored suggestion schema version is invalid", { status: 500 });
  }
  const item = clone(raw);
  item.id = identifier(item.id, "suggestion.id");
  item.owner = identifier(item.owner, "suggestion.owner");
  item.visitId = identifier(item.visitId, "suggestion.visitId");
  item.customerId = identifier(item.customerId, "suggestion.customerId");
  item.customerVersion = positiveInteger(item.customerVersion, "suggestion.customerVersion");
  item.previousValue = relation(item.previousValue, "suggestion.previousValue");
  item.suggestedValue = relation(item.suggestedValue, "suggestion.suggestedValue");
  item.delta = item.suggestedValue - item.previousValue;
  item.createdAt = isoDate(item.createdAt, "suggestion.createdAt", { required: true });
  item.expiresAt = isoDate(item.expiresAt, "suggestion.expiresAt", { required: true });
  if (!STORED_STATUSES.has(item.status)) fail("SUGGESTION_DATA_INVALID", "Stored suggestion status is invalid", { status: 500 });
  if (!SHA256.test(String(item.visitEvidenceHash ?? "")) || !SHA256.test(String(item.inputSnapshotHash ?? ""))) {
    fail("SUGGESTION_DATA_INVALID", "Stored suggestion snapshot hash is invalid", { status: 500 });
  }
  if (!SHA256.test(String(item.identity ?? "")) || digest(identityPayload(item)) !== item.identity) {
    fail("SUGGESTION_DATA_INVALID", "Stored suggestion identity is invalid", { status: 500 });
  }
  return item;
}

function effectiveSuggestion(item, now, { replayed = false } = {}) {
  const result = clone(item);
  if (result.status === "pending" && Date.parse(result.expiresAt) <= now.getTime()) result.status = "expired";
  result.replayed = replayed;
  return result;
}

function notFound() {
  fail("NOT_FOUND", "The visit temperature suggestion was not found", { status: 404 });
}

function unwrapItem(value) {
  return value?.item ?? value;
}

function assertRepository(repository, name, methods) {
  if (!repository || typeof repository !== "object") throw new TypeError(`${name} is required`);
  for (const method of methods) {
    if (typeof repository[method] !== "function") throw new TypeError(`${name}.${method} must be a function`);
  }
}

function assertSynchronous(value) {
  if (value && typeof value.then === "function") throw new TypeError("runInTransaction must execute synchronous work");
  return value;
}

export function createVisitTemperatureSuggestionService({
  visitRepository,
  customerRepository,
  suggestionRepository,
  suggestionGenerator,
  runInTransaction,
  idFactory = randomUUID,
  clock = () => new Date(),
  ttlMs = DEFAULT_TTL_MS,
} = {}) {
  assertRepository(visitRepository, "visitRepository", ["getConfirmed"]);
  assertRepository(customerRepository, "customerRepository", ["getActive", "updateRelation"]);
  assertRepository(suggestionRepository, "suggestionRepository", [
    "findByVisit", "create", "get", "list", "markConfirmed", "markCancelled",
  ]);
  if (typeof suggestionGenerator !== "function") throw new TypeError("suggestionGenerator must be a function");
  if (typeof runInTransaction !== "function") throw new TypeError("runInTransaction must be a function");
  if (typeof idFactory !== "function") throw new TypeError("idFactory must be a function");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_TTL_MS || ttlMs > MAX_TTL_MS) {
    throw new TypeError("ttlMs is outside the supported range");
  }

  const transaction = (work) => assertSynchronous(runInTransaction(work));

  function readSuggestion(ownerValue, suggestionIdValue) {
    const owner = identifier(ownerValue, "owner");
    const suggestionId = identifier(suggestionIdValue, "suggestionId");
    const raw = suggestionRepository.get({ owner, suggestionId });
    if (!raw) notFound();
    const item = normalizeStoredSuggestion(unwrapItem(raw), { owner });
    if (!item) notFound();
    return { owner, suggestionId, item };
  }

  async function suggest({ owner: ownerValue, actor: actorValue = ownerValue, channel = "web", visitId: visitIdValue } = {}) {
    const owner = identifier(ownerValue, "owner");
    const visitId = identifier(visitIdValue, "visitId");
    const existingRaw = suggestionRepository.findByVisit({ owner, visitId });
    if (existingRaw) {
      const existing = normalizeStoredSuggestion(unwrapItem(existingRaw), { owner });
      if (existing) return effectiveSuggestion(existing, clockDate(clock), { replayed: true });
    }

    const visitRaw = visitRepository.getConfirmed({ owner, visitId });
    if (!visitRaw) notFound();
    const visit = normalizeVisit(visitRaw, { owner, visitId });
    if (!visit) notFound();
    const customerRaw = customerRepository.getActive({ owner, customerId: visit.customerId });
    const customer = normalizeCustomer(customerRaw, { owner, customerId: visit.customerId });
    if (!customer) notFound();
    const facts = factsFor(visit, customer);
    const inputSnapshot = {
      visit: visitSnapshot(visit),
      customer: customerSnapshot(customer),
      facts,
    };
    // Keep owner out of the persisted evidence snapshot.  It is an execution
    // boundary supplied by the authenticated service caller, not model input.
    const generatedRaw = await suggestionGenerator(clone(inputSnapshot), Object.freeze({
      owner,
      actor: actorValue,
      channel,
      subject: { type: "visit", id: visit.id },
    }));
    const generated = normalizeGenerated(generatedRaw, facts);
    const now = clockDate(clock);
    const id = identifier(idFactory(), "generated suggestion id");
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    const item = {
      schemaVersion: SCHEMA_VERSION,
      id,
      identity: null,
      owner,
      status: "pending",
      visitId: visit.id,
      visitVersion: visit.version,
      visitEvidenceHash: digest(visitSnapshot(visit)),
      customerId: customer.id,
      customerVersion: customer.version,
      previousValue: customer.relation,
      suggestedValue: generated.suggestedValue,
      delta: generated.suggestedValue - customer.relation,
      confidence: generated.confidence,
      facts,
      inferences: generated.inferences,
      sourceRefs: uniqueSourceRefs(facts.flatMap((fact) => fact.sourceRefs)),
      inputSnapshotHash: digest(inputSnapshot),
      requiresHumanConfirmation: true,
      writebackAllowed: false,
      createdAt,
      expiresAt,
      confirmedAt: null,
      cancelledAt: null,
    };
    item.identity = digest(identityPayload(item));
    const created = transaction(() => suggestionRepository.create(clone(item)));
    const stored = normalizeStoredSuggestion(unwrapItem(created), { owner });
    if (!stored) fail("SUGGESTION_DATA_INVALID", "Created suggestion is invalid", { status: 500 });
    return effectiveSuggestion(stored, now, { replayed: created?.replayed === true });
  }

  function get({ owner, suggestionId } = {}) {
    const loaded = readSuggestion(owner, suggestionId);
    return effectiveSuggestion(loaded.item, clockDate(clock));
  }

  function history({ owner: ownerValue, customerId: customerIdValue = null, limit = 20 } = {}) {
    const owner = identifier(ownerValue, "owner");
    const customerId = customerIdValue === null || customerIdValue === undefined
      ? null
      : identifier(customerIdValue, "customerId");
    const normalizedLimit = Number(limit);
    if (!Number.isSafeInteger(normalizedLimit) || normalizedLimit < 1 || normalizedLimit > MAX_HISTORY) {
      fail("INVALID_INPUT", `limit must be an integer from 1 to ${MAX_HISTORY}`);
    }
    const raw = suggestionRepository.list({ owner, customerId, limit: normalizedLimit });
    const values = Array.isArray(raw) ? raw : raw?.items;
    if (!Array.isArray(values)) fail("SUGGESTION_DATA_INVALID", "Suggestion history is invalid", { status: 500 });
    const now = clockDate(clock);
    const items = values.slice(0, normalizedLimit).flatMap((value) => {
      const item = normalizeStoredSuggestion(unwrapItem(value), { owner });
      if (!item || (customerId && item.customerId !== customerId)) return [];
      return [effectiveSuggestion(item, now)];
    });
    return { items, truncated: raw?.truncated === true || values.length > normalizedLimit };
  }

  function confirm({
    owner: ownerValue,
    suggestionId: suggestionIdValue,
    suggestionIdentity,
    expectedCustomerVersion,
    previousValue,
    confirm: explicitConfirm,
  } = {}) {
    if (explicitConfirm !== true) {
      fail("EXPLICIT_CONFIRMATION_REQUIRED", "An explicit confirm=true is required", { status: 409 });
    }
    const owner = identifier(ownerValue, "owner");
    const suggestionId = identifier(suggestionIdValue, "suggestionId");
    const identity = text(suggestionIdentity, "suggestionIdentity", 64);
    const pinnedVersion = positiveInteger(expectedCustomerVersion, "expectedCustomerVersion");
    const pinnedPreviousValue = relation(previousValue, "previousValue");
    return transaction(() => {
      const raw = suggestionRepository.get({ owner, suggestionId });
      if (!raw) notFound();
      const suggestion = normalizeStoredSuggestion(unwrapItem(raw), { owner });
      if (!suggestion) notFound();
      if (!sameDigest(suggestion.identity, identity)) {
        fail("SUGGESTION_IDENTITY_MISMATCH", "The suggestion identity does not match", { status: 409 });
      }
      if (pinnedVersion !== suggestion.customerVersion || pinnedPreviousValue !== suggestion.previousValue) {
        fail("SUGGESTION_INPUT_MISMATCH", "The pinned customer snapshot does not match the suggestion", { status: 409 });
      }
      const now = clockDate(clock);
      if (suggestion.status === "confirmed") {
        return { status: "confirmed", suggestion: effectiveSuggestion(suggestion, now, { replayed: true }), customer: null, writeback: false, replayed: true };
      }
      if (suggestion.status === "cancelled") {
        return { status: "cancelled", suggestion: effectiveSuggestion(suggestion, now, { replayed: true }), customer: null, writeback: false, replayed: true };
      }
      if (Date.parse(suggestion.expiresAt) <= now.getTime()) {
        return { status: "expired", suggestion: effectiveSuggestion(suggestion, now, { replayed: true }), customer: null, writeback: false, replayed: true };
      }

      const currentVisitRaw = visitRepository.getConfirmed({ owner, visitId: suggestion.visitId });
      let currentVisit = null;
      try {
        currentVisit = currentVisitRaw
          ? normalizeVisit(currentVisitRaw, { owner, visitId: suggestion.visitId })
          : null;
      } catch (error) {
        if (!(error instanceof VisitTemperatureSuggestionError)) throw error;
      }
      if (!currentVisit || digest(visitSnapshot(currentVisit)) !== suggestion.visitEvidenceHash) {
        return {
          status: "conflict",
          reason: "visit_evidence_changed",
          suggestion: effectiveSuggestion(suggestion, now),
          currentCustomer: null,
          writeback: false,
          replayed: false,
        };
      }

      const currentRaw = customerRepository.getActive({ owner, customerId: suggestion.customerId });
      const current = normalizeCustomer(currentRaw, { owner, customerId: suggestion.customerId });
      if (!current) {
        return {
          status: "conflict",
          reason: "customer_unavailable",
          suggestion: effectiveSuggestion(suggestion, now),
          currentCustomer: null,
          writeback: false,
          replayed: false,
        };
      }
      if (current.version !== suggestion.customerVersion || current.relation !== suggestion.previousValue) {
        return {
          status: "conflict",
          reason: "customer_changed",
          suggestion: effectiveSuggestion(suggestion, now),
          currentCustomer: customerSnapshot(current),
          writeback: false,
          replayed: false,
        };
      }

      let updateResult;
      try {
        updateResult = customerRepository.updateRelation({
          owner,
          customerId: suggestion.customerId,
          expectedVersion: suggestion.customerVersion,
          expectedRelation: suggestion.previousValue,
          relation: suggestion.suggestedValue,
          suggestionId: suggestion.id,
        });
      } catch (error) {
        if (error?.code === "VERSION_CONFLICT" || error?.code === "NOT_FOUND") {
          const latestRaw = customerRepository.getActive({ owner, customerId: suggestion.customerId });
          const latest = normalizeCustomer(latestRaw, { owner, customerId: suggestion.customerId });
          return {
            status: "conflict",
            reason: error.code === "VERSION_CONFLICT" ? "customer_changed" : "customer_unavailable",
            suggestion: effectiveSuggestion(suggestion, now),
            currentCustomer: latest ? customerSnapshot(latest) : null,
            writeback: false,
            replayed: false,
          };
        }
        throw error;
      }
      if (updateResult?.conflict || updateResult?.notFound) {
        const rawCurrent = updateResult.current
          ?? customerRepository.getActive({ owner, customerId: suggestion.customerId });
        const latest = normalizeCustomer(rawCurrent, { owner, customerId: suggestion.customerId });
        return {
          status: "conflict",
          reason: updateResult.conflict ? "customer_changed" : "customer_unavailable",
          suggestion: effectiveSuggestion(suggestion, now),
          currentCustomer: latest ? customerSnapshot(latest) : null,
          writeback: false,
          replayed: false,
        };
      }
      const updated = normalizeCustomer(unwrapItem(updateResult), { owner, customerId: suggestion.customerId });
      if (!updated || updated.relation !== suggestion.suggestedValue || updated.version <= suggestion.customerVersion) {
        fail("CUSTOMER_UPDATE_INVALID", "The customer update result is invalid", { status: 500 });
      }
      const confirmedRaw = suggestionRepository.markConfirmed({
        owner,
        suggestionId: suggestion.id,
        identity: suggestion.identity,
        confirmedAt: now.toISOString(),
        customerVersion: updated.version,
        relation: updated.relation,
      });
      if (!confirmedRaw) fail("SUGGESTION_STATE_CONFLICT", "The suggestion state changed during confirmation", { status: 409 });
      const confirmed = normalizeStoredSuggestion(unwrapItem(confirmedRaw), { owner });
      return {
        status: "confirmed",
        suggestion: effectiveSuggestion(confirmed, now),
        customer: customerSnapshot(updated),
        writeback: true,
        replayed: false,
      };
    });
  }

  function cancel({
    owner: ownerValue,
    suggestionId: suggestionIdValue,
    suggestionIdentity,
    cancel: explicitCancel,
  } = {}) {
    if (explicitCancel !== true) {
      fail("EXPLICIT_CANCELLATION_REQUIRED", "An explicit cancel=true is required", { status: 409 });
    }
    const owner = identifier(ownerValue, "owner");
    const suggestionId = identifier(suggestionIdValue, "suggestionId");
    const identity = text(suggestionIdentity, "suggestionIdentity", 64);
    return transaction(() => {
      const raw = suggestionRepository.get({ owner, suggestionId });
      if (!raw) notFound();
      const suggestion = normalizeStoredSuggestion(unwrapItem(raw), { owner });
      if (!suggestion) notFound();
      if (!sameDigest(suggestion.identity, identity)) {
        fail("SUGGESTION_IDENTITY_MISMATCH", "The suggestion identity does not match", { status: 409 });
      }
      const now = clockDate(clock);
      if (suggestion.status === "cancelled") {
        return { status: "cancelled", suggestion: effectiveSuggestion(suggestion, now, { replayed: true }), replayed: true };
      }
      if (suggestion.status === "confirmed") {
        return { status: "confirmed", suggestion: effectiveSuggestion(suggestion, now, { replayed: true }), replayed: true };
      }
      if (Date.parse(suggestion.expiresAt) <= now.getTime()) {
        return { status: "expired", suggestion: effectiveSuggestion(suggestion, now, { replayed: true }), replayed: true };
      }
      const cancelledRaw = suggestionRepository.markCancelled({
        owner,
        suggestionId: suggestion.id,
        identity: suggestion.identity,
        cancelledAt: now.toISOString(),
      });
      if (!cancelledRaw) fail("SUGGESTION_STATE_CONFLICT", "The suggestion state changed during cancellation", { status: 409 });
      const cancelled = normalizeStoredSuggestion(unwrapItem(cancelledRaw), { owner });
      return { status: "cancelled", suggestion: effectiveSuggestion(cancelled, now), replayed: false };
    });
  }

  return Object.freeze({ suggest, get, history, confirm, cancel });
}

export { SCHEMA_VERSION as VISIT_TEMPERATURE_SUGGESTION_SCHEMA_VERSION };
